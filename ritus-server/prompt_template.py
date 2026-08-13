"""System prompt for the AI autofix (ai_tools.py -> local Ollama model).

Kept deliberately short. The configured model (gemma4:e4b) is loaded with a
4096-token context, and the OCR page plus the corrected output already take
1000-1500 of those, so every line here competes with the text we actually
want fixed.

Measured on the four pages in "Transcription Tests.txt" (word similarity to
the human correction, mean of 4):

    raw OCR, no processing                      0.5098
    find/replace only, no AI                    0.5162
    previous prompt, find/replace off           0.5187   <- old behaviour
    previous prompt, find/replace on            0.5258
    + context rules, no function list           0.5144   <- worse, see below
    + context rules + FULL 116-function list    0.5298
    + context rules + short function list       0.5363   <- this file

Two findings drove the shape of this file:

  - The context rules alone made things WORSE (0.5144). Given conditional
    instructions and no vocabulary, the model over-edits. Pairing them with a
    list of real function names grounds it and turns the same rules into a
    gain on every page.
  - The short list beats the full 116-name list (0.5363 vs 0.5298) while
    costing ~380 fewer prompt tokens. Rare functions are dead weight for a
    model this size; the full list is in
    ritus-client/public/data/functions.csv if it is ever needed.

Mechanical, context-free replacements are NOT here - they run before this
prompt, in transcription_autofix.py / data/common_transcription_errors.tsv.
Only fixes that need surrounding words to decide belong in this file.
"""

SYSTEM_PROMPT = """Fix OCR errors in medieval Latin liturgical text.
Rules:
- Fix only typos and OCR misreads. Do NOT add, invent, or remove words.
- Split merged words and merge incorrectly split words.
- Wrap rite/rubric names in <red></red> tags.
- Wrap prayer function names in <func></func> tags.
- Separate distinct prayers with the ⏎ character.
- Close all tags properly.
- Output ONLY the corrected text, nothing else.

Context-dependent fixes (only when the condition holds):
- quas -> quesumus: only as a whole word next to domine/omnipotens/sempiterne or after Presta/resta. Keep quas as a relative pronoun or word ending (aquas).
- quam -> quoniam: only as a whole word opening a clause. Keep as relative pronoun or ending (aquam).
- spem -> spiritum: only next to sanctum.
- dies -> deus: only where "god" fits and "day" does not.
- tius -> tuis: only as a whole word, never as a word ending.
- l -> s: only where l makes a non-word and s makes a real word (rel -> res).
- o -> con: only where the letters up to the next space are a non-word that becomes a real word with con.
- xps/xpi/xpm -> christus/christi/christum. Never change xp inside a real word (expiando).
- Spell it quesumus, michi, eterne.

Isolated rubric abbreviations - expand, then tag as a function and start a new prayer:
Gru -> Graduale; V -> Versus (not when it is the numeral 5); Oster/official -> Offertorium; "p st com" -> Post communionem; Pes -> Per (only ending a prayer); eria -> alleluia (paschal context).

Prayer functions (use these names in <func>; "A < B" means A is a subfunction of B):
Introitus, Versus Introitus < Introitus, Collecta, Lectio, Epistola, Graduale, Versus Gradualis < Graduale, Alleluia, Versus Alleluiaticus < Alleluia, Tractus, Sequentia, Evangelium, Offertorium, Versus Offertorii < Offertorium, Secreta, Prefatio, Canon missae, Infra actionem < Canon missae, Communicantes, Hanc igitur, Qui pridie, Unde et memores, Nobis quoque peccatoribus, Per ipsum, Pater noster, Agnus dei, Communio, Versus Communionis < Communio, Post communionem, Ad complendum, Super populum, Oratio, Psalmus, Versus, Antiphona, Responsorium, Rubrica, Benedictio, Hymnus, Sanctus, Kyrie, Gloria, Credo"""

# Backward compatibility for scripts that use PROMPT_TEXT directly
PROMPT_TEXT = SYSTEM_PROMPT + "\n\nOCR text:\n\n"
