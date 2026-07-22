import React, { useRef, useState, useCallback, useEffect, useId } from "react";
import { Box, Stack, Button, Input, Text } from "@chakra-ui/react";
import {
  FaSave,
  FaLevelDownAlt,
  FaSearch,
  FaTimes,
  FaChevronUp,
  FaChevronDown,
} from "react-icons/fa";
import { toaster } from "@/components/ui/toaster";

const MATCH_HIGHLIGHT = "ritus-find-match";
const CURRENT_HIGHLIGHT = "ritus-find-current";

const highlightsSupported = () =>
  typeof CSS !== "undefined" &&
  typeof CSS.highlights !== "undefined" &&
  typeof Highlight !== "undefined";

const TranscriptionEditor = ({
  transcriptionText,
  setTranscriptionText,
  selectedImage,
  handleTranscriptionUpdate,
  isDisabled = false,
}) => {
  const editorRef = useRef(null);
  const lastLoadedImageIdRef = useRef(selectedImage?.id ?? null);
  const [localContent, setLocalContent] = useState("");
  const findInputRef = useRef(null);
  const currentMatchRef = useRef(-1);
  const [isFindOpen, setIsFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(-1);
  // Highlight names are global, so keep them unique per editor instance
  const instanceId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const matchHighlight = `${MATCH_HIGHLIGHT}-${instanceId}`;
  const currentHighlight = `${CURRENT_HIGHLIGHT}-${instanceId}`;

  const normalizeEditorHtml = (html) =>
    (html || "")
      .replace(/<div><br><\/div>/gi, "<br>")
      .replace(/<div>/gi, "<br>")
      .replace(/<\/div>/gi, "")
      .replace(/<br\s*\/?>/gi, "<br>")
      .trim();

  // Convert <red> tags to <b>, <func> to <i>, and <subrub> to <u> for display
  const parseToHtml = (text) => {
    console.debug("Parsing transcriptionText to HTML:", text);
    const result = text
      ? text
        .replace(/<red>/gi, "<b>")
        .replace(/<\/red>/gi, "</b>")
        .replace(/<func>/gi, "<i>")
        .replace(/<\/func>/gi, "</i>")
        .replace(/<subrub>/gi, "<u>")
        .replace(/<\/subrub>/gi, "</u>")
        .replace(/\n/g, "<br>")
      : "";
    console.debug("Parsed HTML:", result);
    return result;
  };

  const parseToTaggedText = (html) => {
    console.debug("Parsing HTML to tagged text:", html);
    const normalizedHtml = html
      .replace(/<div>/gi, "<br>")
      .replace(/<\/div>/gi, "")
      .replace(/<b>|<strong>/gi, "<red>")
      .replace(/<\/b>|<\/strong>/gi, "</red>")
      .replace(/<i>/gi, "<func>")
      .replace(/<\/i>/gi, "</func>")
      .replace(/<u>/gi, "<subrub>")
      .replace(/<\/u>/gi, "</subrub>")
      .replace(/<br>/gi, "\n")
      .replace(/&nbsp;/g, " ");
    console.debug("Parsed tagged text:", normalizedHtml);
    return normalizedHtml;
  };

  // Initialize editor with external transcriptionText
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    console.debug(
      "Initializing editor with transcriptionText:",
      transcriptionText
    );
    const newHtml = parseToHtml(transcriptionText || "");
    const normalizedCurrent = normalizeEditorHtml(editor.innerHTML);
    const normalizedNew = normalizeEditorHtml(newHtml);
    const selectedImageId = selectedImage?.id ?? null;
    const imageChanged = lastLoadedImageIdRef.current !== selectedImageId;
    const editorHasFocus = document.activeElement === editor;

    if (!imageChanged && editorHasFocus) {
      return;
    }

    if (normalizedCurrent !== normalizedNew) {
      editor.innerHTML = newHtml;
      cleanEditor();
      setLocalContent(parseToTaggedText(editor.innerHTML));
    }
    lastLoadedImageIdRef.current = selectedImageId;
  }, [transcriptionText, selectedImage, isDisabled]);

  // Prevent default backspace behavior
  const handleKeyDown = (e) => {
    if (isDisabled) {
      console.debug("Keydown prevented: Editor is disabled");
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openFind();
      return;
    }
    if (e.key === "Escape" && isFindOpen) {
      e.preventDefault();
      closeFind();
    }
  };

  // Clean editor
  function cleanEditor() {
    const editor = editorRef.current;
    const allowedTags = ["I", "B", "STRONG", "U", "DIV", "BR"];
    console.debug("Cleaning editor, initial HTML:", editor.innerHTML);

    function clean(node) {
      const children = Array.from(node.childNodes);
      for (let child of children) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          const tagName = child.tagName.toUpperCase();
          if (!allowedTags.includes(tagName)) {
            const frag = document.createDocumentFragment();
            while (child.firstChild) frag.appendChild(child.firstChild);
            node.replaceChild(frag, child);
            clean(frag);
          } else {
            clean(child);
          }
        }
      }
    }

    clean(editor);
    console.debug("Cleaned editor HTML:", editor.innerHTML);
  }

  // Push the current editor content back to local state and the parent
  const syncFromEditor = () => {
    cleanEditor();
    const taggedText = parseToTaggedText(editorRef.current.innerHTML).trim();
    setLocalContent(taggedText);
    setTranscriptionText(taggedText);
    return taggedText;
  };

  // Handle editor input
  const handleInput = useCallback(() => {
    if (isDisabled) {
      console.debug("Input ignored: Editor is disabled");
      return;
    }
    const editor = editorRef.current;
    console.debug("Editor input detected, current HTML:", editor.innerHTML);
    const taggedText = parseToTaggedText(editor.innerHTML).trim();
    setLocalContent(taggedText);
    setTranscriptionText(taggedText);
    console.debug("Updated transcriptionText:", taggedText);
  }, [isDisabled, setTranscriptionText]);

  // Toggle selected text to red (bold) or black
  const toggleBold = () => {
    if (isDisabled) {
      console.debug("Bold toggle ignored: Editor is disabled");
      return;
    }
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) {
      console.debug("No text selected for bold toggle");
      toaster.create({
        title: "No Text Selected",
        description: "Please select some text to change its style.",
        type: "warning",
        duration: 5000,
      });
      return;
    }

    try {
      document.execCommand("removeFormat", false, null); // Remove all formatting
      document.execCommand("bold", false, null); // Apply bold only
      const taggedText = syncFromEditor();
      console.debug("Bold applied, updated transcriptionText:", taggedText);
    } catch (e) {
      console.debug("Error toggling bold:", e.message);
    }
  };

  // Toggle selected text to italic (func)
  const toggleItalic = () => {
    if (isDisabled) {
      console.debug("Italic toggle ignored: Editor is disabled");
      return;
    }
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) {
      console.debug("No text selected for italic toggle");
      toaster.create({
        title: "No Text Selected",
        description: "Please select some text to change its style.",
        type: "warning",
        duration: 5000,
      });
      return;
    }

    try {
      document.execCommand("removeFormat", false, null); // Remove all formatting
      document.execCommand("italic", false, null); // Apply italic only
      const taggedText = syncFromEditor();
      console.debug("Italic applied, updated transcriptionText:", taggedText);
    } catch (e) {
      console.debug("Error toggling italic:", e.message);
    }
  };

  // Toggle selected text to underline (subrub)
  const toggleUnderline = () => {
    if (isDisabled) {
      console.debug("Underline toggle ignored: Editor is disabled");
      return;
    }
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) {
      console.debug("No text selected for underline toggle");
      toaster.create({
        title: "No Text Selected",
        description: "Please select some text to change its style.",
        type: "warning",
        duration: 5000,
      });
      return;
    }

    try {
      document.execCommand("removeFormat", false, null); // Remove all formatting
      document.execCommand("underline", false, null); // Apply underline only
      const taggedText = syncFromEditor();
      console.debug("Underline applied, updated transcriptionText:", taggedText);
    } catch (e) {
      console.debug("Error toggling underline:", e.message);
    }
  };

  // Remove formatting from selected text
  const toggleRemoveFormat = () => {
    if (isDisabled) {
      console.debug("Remove format ignored: Editor is disabled");
      return;
    }
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) {
      console.debug("No text selected for clear formatting");
      toaster.create({
        title: "No Text Selected",
        description: "Please select some text to change its style.",
        type: "warning",
        duration: 5000,
      });
      return;
    }

    try {
      document.execCommand("removeFormat", false, null); // Remove all formatting
      const taggedText = syncFromEditor();
      console.debug(
        "Formatting removed, updated transcriptionText:",
        taggedText
      );
    } catch (e) {
      console.debug("Error toggling clear formatting:", e.message);
    }
  };

  // Insert line break at cursor
  const insertLineBreak = () => {
    if (isDisabled) {
      console.debug("Insert line break ignored: Editor is disabled");
      return;
    }
    try {
      const text = " \n⏎\n";
      document.execCommand("insertText", false, text);
      const taggedText = syncFromEditor();
      console.debug("Line break inserted, updated transcriptionText:", taggedText);
    } catch (e) {
      console.debug("Error inserting line break:", e.message);
    }
  };

  // Flatten the editor into plain text, keeping a map back to the text nodes.
  // <br> is emitted as "\n" so a match can never span a line break.
  const buildTextIndex = () => {
    const editor = editorRef.current;
    if (!editor) return { text: "", segments: [] };
    const walker = document.createTreeWalker(
      editor,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT
    );
    let text = "";
    const segments = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.nodeValue.replace(/\u00a0/g, " ");
        segments.push({
          node,
          start: text.length,
          end: text.length + value.length,
        });
        text += value;
      } else if (node.tagName === "BR") {
        text += "\n";
      }
    }
    return { text, segments };
  };

  const findMatches = (text, needle) => {
    if (!needle) return [];
    let haystack = text;
    let target = needle;
    if (!matchCase) {
      const lowered = text.toLowerCase();
      // Some characters change length when lowercased, which would break offsets
      if (lowered.length === text.length) {
        haystack = lowered;
        target = needle.toLowerCase();
      }
    }
    const matches = [];
    let from = 0;
    while (from <= haystack.length - target.length) {
      const index = haystack.indexOf(target, from);
      if (index === -1) break;
      matches.push({ start: index, end: index + target.length });
      from = index + target.length;
    }
    return matches;
  };

  const rangeFromOffsets = (segments, start, end) => {
    let startNode = null;
    let startOffset = 0;
    let endNode = null;
    let endOffset = 0;
    for (const segment of segments) {
      if (!startNode && start >= segment.start && start < segment.end) {
        startNode = segment.node;
        startOffset = start - segment.start;
      }
      if (end > segment.start && end <= segment.end) {
        endNode = segment.node;
        endOffset = end - segment.start;
        break;
      }
    }
    if (!startNode || !endNode) return null;
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  };

  const clearHighlights = () => {
    if (!highlightsSupported()) return;
    CSS.highlights.delete(matchHighlight);
    CSS.highlights.delete(currentHighlight);
  };

  const paintHighlights = (segments, matches, activeIndex) => {
    if (!highlightsSupported()) return;
    const others = [];
    let active = null;
    matches.forEach((match, index) => {
      const range = rangeFromOffsets(segments, match.start, match.end);
      if (!range) return;
      if (index === activeIndex) active = range;
      else others.push(range);
    });
    CSS.highlights.set(matchHighlight, new Highlight(...others));
    if (active) CSS.highlights.set(currentHighlight, new Highlight(active));
    else CSS.highlights.delete(currentHighlight);
  };

  // Recompute matches against the live DOM and repaint the highlights
  const refreshMatches = (activeIndex = currentMatchRef.current) => {
    const { text, segments } = buildTextIndex();
    const matches = findMatches(text, findText);
    const index = matches.length
      ? Math.min(Math.max(activeIndex, -1), matches.length - 1)
      : -1;
    currentMatchRef.current = index;
    setMatchCount(matches.length);
    setCurrentMatch(index);
    paintHighlights(segments, matches, index);
    return { segments, matches };
  };

  const scrollRangeIntoView = (range) => {
    const editor = editorRef.current;
    const rect = range.getBoundingClientRect();
    const bounds = editor.getBoundingClientRect();
    if (!rect.height && !rect.width) return;
    if (rect.top < bounds.top) {
      editor.scrollTop -= bounds.top - rect.top + 20;
    } else if (rect.bottom > bounds.bottom) {
      editor.scrollTop += rect.bottom - bounds.bottom + 20;
    }
  };

  const revealMatch = (segments, matches, index) => {
    const match = matches[index];
    if (!match) return null;
    const range = rangeFromOffsets(segments, match.start, match.end);
    if (!range) return null;
    scrollRangeIntoView(range);
    // Without the highlight API the only way to show the match is to select it
    if (!highlightsSupported()) {
      editorRef.current.focus();
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return range;
  };

  // Move to the next/previous match, wrapping around
  const goToMatch = (step) => {
    const { text, segments } = buildTextIndex();
    const matches = findMatches(text, findText);
    if (!matches.length) {
      currentMatchRef.current = -1;
      setMatchCount(0);
      setCurrentMatch(-1);
      clearHighlights();
      return;
    }
    const previous = currentMatchRef.current;
    const next =
      previous === -1
        ? step > 0
          ? 0
          : matches.length - 1
        : (previous + step + matches.length) % matches.length;
    currentMatchRef.current = next;
    setMatchCount(matches.length);
    setCurrentMatch(next);
    paintHighlights(segments, matches, next);
    revealMatch(segments, matches, next);
  };

  // Select a range inside the editor and overwrite it, keeping the undo stack
  const overwriteRange = (range) => {
    const selection = window.getSelection();
    editorRef.current.focus();
    selection.removeAllRanges();
    selection.addRange(range);
    if (replaceText) document.execCommand("insertText", false, replaceText);
    else document.execCommand("delete", false, null);
  };

  const replaceCurrent = () => {
    if (isDisabled || !findText) return;
    const { segments, matches } = refreshMatches();
    if (!matches.length) return;
    // Nothing stepped through yet: replace the first match
    const index = currentMatchRef.current === -1 ? 0 : currentMatchRef.current;
    const range = rangeFromOffsets(
      segments,
      matches[index].start,
      matches[index].end
    );
    if (!range) return;
    overwriteRange(range);
    const taggedText = syncFromEditor();
    console.debug("Replaced one occurrence, updated transcriptionText:", taggedText);
    // Land on the first match after the text we just inserted
    const after = matches[index].start + replaceText.length;
    const { text: newText, segments: newSegments } = buildTextIndex();
    const newMatches = findMatches(newText, findText);
    const nextIndex = newMatches.findIndex((match) => match.start >= after);
    const target = newMatches.length ? (nextIndex === -1 ? 0 : nextIndex) : -1;
    currentMatchRef.current = target;
    setMatchCount(newMatches.length);
    setCurrentMatch(target);
    paintHighlights(newSegments, newMatches, target);
    if (target !== -1) revealMatch(newSegments, newMatches, target);
  };

  const replaceAll = () => {
    if (isDisabled || !findText) return;
    let replaced = 0;
    let from = 0;
    // Each replacement invalidates the index, so rebuild it every pass
    while (replaced < 10000) {
      const { text, segments } = buildTextIndex();
      const match = findMatches(text, findText).find(
        (candidate) => candidate.start >= from
      );
      if (!match) break;
      const range = rangeFromOffsets(segments, match.start, match.end);
      if (!range) break;
      overwriteRange(range);
      from = match.start + replaceText.length;
      replaced += 1;
    }
    if (replaced) {
      const taggedText = syncFromEditor();
      console.debug("Replaced all occurrences, updated transcriptionText:", taggedText);
    }
    currentMatchRef.current = -1;
    refreshMatches(-1);
    toaster.create({
      title: replaced ? "Replace All" : "Nothing Replaced",
      description: replaced
        ? `Replaced ${replaced} occurrence${replaced === 1 ? "" : "s"}.`
        : `"${findText}" was not found.`,
      type: replaced ? "success" : "warning",
      duration: 4000,
    });
  };

  const openFind = () => {
    const selection = window.getSelection();
    const selectedText =
      selection.rangeCount &&
      editorRef.current?.contains(selection.anchorNode) &&
      !selection.isCollapsed
        ? selection.toString().replace(/\u00a0/g, " ")
        : "";
    if (selectedText && !selectedText.includes("\n")) setFindText(selectedText);
    currentMatchRef.current = -1;
    setCurrentMatch(-1);
    setIsFindOpen(true);
  };

  const closeFind = () => {
    setIsFindOpen(false);
    currentMatchRef.current = -1;
    setCurrentMatch(-1);
    setMatchCount(0);
    clearHighlights();
    editorRef.current?.focus();
  };

  const handleFindKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      goToMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFind();
    }
  };

  // Keep the match list in sync with the text and the search options
  useEffect(() => {
    if (!isFindOpen || !findText) {
      clearHighlights();
      setMatchCount(0);
      setCurrentMatch(-1);
      currentMatchRef.current = -1;
      return;
    }
    refreshMatches();
    // refreshMatches only reads findText/matchCase, both listed below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFindOpen, findText, matchCase, localContent, transcriptionText]);

  useEffect(() => {
    if (isFindOpen) findInputRef.current?.focus();
  }, [isFindOpen]);

  // Drop this instance's highlights when it unmounts
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => clearHighlights(), []);

  // Handle save button click
  const handleSave = () => {
    if (isDisabled) {
      console.debug("Save ignored: Editor is disabled");
      return;
    }
    console.debug("Save button clicked, selectedImage:", selectedImage);
    if (!selectedImage) {
      console.debug("No image selected, showing toast");
      toaster.create({
        title: "Save Error",
        description: "No image selected for saving transcription.",
        type: "error",
        duration: 5000,
      });
      return;
    }
    const taggedText = syncFromEditor();
    console.debug("Saving transcriptionText:", taggedText);
    handleTranscriptionUpdate();
  };

  return (
    <Stack spacing={2} flex="1" minH={0}>
      <style>{`
        ::highlight(${matchHighlight}) { background-color: #fde68a; }
        ::highlight(${currentHighlight}) { background-color: #fb923c; }
      `}</style>
      <Box
        ref={editorRef}
        id="editor"
        contentEditable={!isDisabled}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        border="1px solid"
        borderColor="gray.200"
        borderRadius="md"
        p={2}
        flex="1"
        minH="150px"
        overflowY="auto"
        whiteSpace="pre-wrap"
        bg="white"
        _focus={{ outline: "2px solid", outlineColor: "blue.500" }}
        css={{
          "& b, & strong": {
            color: "red",
            fontWeight: "bold",
          },
          "& i": {
            color: "blue",
            fontStyle: "italic",
          },
          "& u": {
            color: "green",
            textDecoration: "underline",
          },
        }}
        suppressContentEditableWarning
      />
      {!isDisabled && isFindOpen && (
        <Stack spacing={1} width="100%">
          <Stack direction="row" spacing={1} width="100%" align="center">
            <Input
              ref={findInputRef}
              size="sm"
              bg="white"
              placeholder="Find"
              value={findText}
              onChange={(e) => setFindText(e.target.value)}
              onKeyDown={handleFindKeyDown}
              flex="1"
            />
            <Text
              fontSize="xs"
              color={findText && !matchCount ? "red.500" : "gray.600"}
              minW="48px"
              textAlign="center"
            >
              {`${currentMatch >= 0 ? currentMatch + 1 : 0}/${matchCount}`}
            </Text>
            <Button
              size="sm"
              px={2}
              variant={matchCase ? "solid" : "outline"}
              onClick={() => setMatchCase((previous) => !previous)}
              title="Match case"
            >
              Aa
            </Button>
            <Button
              size="sm"
              px={2}
              variant="outline"
              onClick={() => goToMatch(-1)}
              disabled={!matchCount}
              title="Previous match (Shift+Enter)"
            >
              <FaChevronUp />
            </Button>
            <Button
              size="sm"
              px={2}
              variant="outline"
              onClick={() => goToMatch(1)}
              disabled={!matchCount}
              title="Next match (Enter)"
            >
              <FaChevronDown />
            </Button>
            <Button
              size="sm"
              px={2}
              variant="ghost"
              onClick={closeFind}
              title="Close (Esc)"
            >
              <FaTimes />
            </Button>
          </Stack>
          <Stack direction="row" spacing={1} width="100%" align="center">
            <Input
              size="sm"
              bg="white"
              placeholder="Replace with"
              value={replaceText}
              onChange={(e) => setReplaceText(e.target.value)}
              onKeyDown={handleFindKeyDown}
              flex="1"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={replaceCurrent}
              disabled={!matchCount}
            >
              Replace
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={replaceAll}
              disabled={!matchCount}
            >
              All
            </Button>
          </Stack>
        </Stack>
      )}
      {!isDisabled && (
        <Stack direction="row" spacing={2} width="100%">
          <Button size="sm" onClick={toggleRemoveFormat} flex="0.4">
            Text
          </Button>
          <Button size="sm" colorPalette="red" onClick={toggleBold} flex="0.8">
            Rubric
          </Button>
          <Button size="sm" colorPalette="green" onClick={toggleUnderline} flex="0.8">
            Subrubric
          </Button>
          <Button size="sm" colorPalette="blue" onClick={toggleItalic} flex="0.8">
            Function
          </Button>
          <Button size="sm" onClick={insertLineBreak} flex="0.1">
            ⏎
          </Button>
          <Button
            size="sm"
            flex="0.1"
            variant={isFindOpen ? "solid" : "outline"}
            onClick={() => (isFindOpen ? closeFind() : openFind())}
            title="Find and replace (Ctrl+F)"
          >
            <FaSearch />
          </Button>
        </Stack>
      )}
      {!isDisabled && (
        <Button
          size="sm"
          variant="solid"
          onClick={handleSave}
          disabled={!selectedImage}
        >
          <FaSave />
          Save
        </Button>
      )}
    </Stack>
  );
};

export default TranscriptionEditor;