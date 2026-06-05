SYSTEM_PROMPT = """Fix OCR errors in medieval Latin liturgical text.
Rules:
- Fix only typos and OCR misreads. Do NOT add, invent, or remove words.
- Split merged words and merge incorrectly split words.
- Wrap rite/rubric names in <red></red> tags.
- Wrap prayer function names in <func></func> tags.
- Separate distinct prayers with the ⏎ character.
- Close all tags properly.
- Output ONLY the corrected text, nothing else."""

# Backward compatibility for scripts that use PROMPT_TEXT directly
PROMPT_TEXT = SYSTEM_PROMPT + "\n\nOCR text:\n\n"
