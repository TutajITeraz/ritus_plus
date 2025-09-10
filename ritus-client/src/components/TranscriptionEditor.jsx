import React, { useRef, useState, useCallback, useEffect } from "react";
import { Box, Stack, Button, Icon } from "@chakra-ui/react";
import { FaPaintBrush, FaSave } from "react-icons/fa";
import { toaster } from "@/components/ui/toaster";

const TranscriptionEditor = ({
  transcriptionText,
  setTranscriptionText,
  selectedImage,
  handleTranscriptionUpdate,
  isDisabled = false,
}) => {
  const editorRef = useRef(null);
  const [localContent, setLocalContent] = useState("");

  // Convert <red> tags to <b> and <func> to <i> for display
  const parseToHtml = (text) => {
    console.debug("Parsing transcriptionText to HTML:", text);
    const result = text
      ? text
          .replace(/<red>/gi, "<b>")
          .replace(/<\/red>/gi, "</b>")
          .replace(/<func>/gi, "<i>")
          .replace(/<\/func>/gi, "</i>")
          .replace(/\n/g, "<br>")
      : '<span style="color: gray;">No transcription available</span>';
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
      .replace(/<br>/gi, "\n")
      .replace(/&nbsp;/g, " ");
    console.debug("Parsed tagged text:", normalizedHtml);
    return normalizedHtml;
  };

  // Initialize editor with external transcriptionText
  useEffect(() => {
    const editor = editorRef.current;
    console.debug(
      "Initializing editor with transcriptionText:",
      transcriptionText
    );
    editor.innerHTML = parseToHtml(transcriptionText || "");
    cleanEditor();
    setLocalContent(parseToTaggedText(editor.innerHTML));
  }, [transcriptionText, isDisabled]);

  // Prevent default backspace behavior
  const handleKeyDown = (e) => {
    if (isDisabled) {
      console.debug("Keydown prevented: Editor is disabled");
      e.preventDefault();
      return;
    }
    if (e.key === "Backspace" && editorRef.current.innerHTML === "") {
      e.preventDefault(); // Prevent browser navigation
      console.debug("Backspace prevented, resetting to placeholder");
      editorRef.current.innerHTML =
        '<span style="color: gray;">No transcription available</span>';
      setTranscriptionText("");
      setLocalContent("");
    }
  };

  // Clean editor
  function cleanEditor() {
    const editor = editorRef.current;
    const allowedTags = ["I", "B", "STRONG", "DIV", "BR"];
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

  // Handle editor input
  const handleInput = useCallback(() => {
    if (isDisabled) {
      console.debug("Input ignored: Editor is disabled");
      return;
    }
    const editor = editorRef.current;
    console.debug("Editor input detected, current HTML:", editor.innerHTML);
    if (
      editor.innerHTML ===
      '<span style="color: gray;">No transcription available</span>'
    ) {
      setTranscriptionText("");
      setLocalContent("");
      console.debug("Editor cleared, transcriptionText set to empty");
      return;
    }
    cleanEditor();
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
      cleanEditor();
      const taggedText = parseToTaggedText(editorRef.current.innerHTML).trim();
      setLocalContent(taggedText);
      setTranscriptionText(taggedText);
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
      cleanEditor();
      const taggedText = parseToTaggedText(editorRef.current.innerHTML).trim();
      setLocalContent(taggedText);
      setTranscriptionText(taggedText);
      console.debug("Italic applied, updated transcriptionText:", taggedText);
    } catch (e) {
      console.debug("Error toggling italic:", e.message);
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
      cleanEditor();
      const taggedText = parseToTaggedText(editorRef.current.innerHTML).trim();
      setLocalContent(taggedText);
      setTranscriptionText(taggedText);
      console.debug(
        "Formatting removed, updated transcriptionText:",
        taggedText
      );
    } catch (e) {
      console.debug("Error toggling clear formatting:", e.message);
    }
  };

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
    cleanEditor();
    const taggedText = parseToTaggedText(editorRef.current.innerHTML).trim();
    console.debug("Saving transcriptionText:", taggedText);
    setLocalContent(taggedText);
    setTranscriptionText(taggedText);
    handleTranscriptionUpdate();
  };

  return (
    <Stack spacing={2} flex="1">
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
        h="350px"
        maxH="600px"
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
        }}
        suppressContentEditableWarning
      />
      {!isDisabled && (
        <Stack direction="row" spacing={2} width="100%">
          <Button size="sm" onClick={toggleRemoveFormat} flex="1">
            Text
          </Button>
          <Button size="sm" colorPalette="red" onClick={toggleBold} flex="1">
            Rite in a rubric
          </Button>
          <Button size="sm" colorPalette="blue" onClick={toggleItalic} flex="1">
            Prayer function
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
