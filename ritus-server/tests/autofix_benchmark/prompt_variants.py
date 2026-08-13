"""Candidate system prompts for the AI autofix, for A/B measurement."""

# --------------------------------------------------------------------------
# P0 - what is in prompt_template.py today (the BEFORE baseline)
# --------------------------------------------------------------------------
P0 = """Fix OCR errors in medieval Latin liturgical text.
Rules:
- Fix only typos and OCR misreads. Do NOT add, invent, or remove words.
- Split merged words and merge incorrectly split words.
- Wrap rite/rubric names in <red></red> tags.
- Wrap prayer function names in <func></func> tags.
- Separate distinct prayers with the ⏎ character.
- Close all tags properly.
- Output ONLY the corrected text, nothing else."""


# --------------------------------------------------------------------------
# Context-dependent fixes, reformatted from the spreadsheet's "instructions"
# column and cell comments. These are exactly the cases that CANNOT be done
# by blind find/replace, compressed to one line each.
# --------------------------------------------------------------------------
CONTEXT_RULES = """
Context-dependent fixes (only when the condition holds):
- quas -> quesumus: only as a whole word next to domine/omnipotens/sempiterne or after Presta/resta. Keep quas as a relative pronoun or word ending (aquas).
- quam -> quoniam: only as a whole word opening a clause. Keep as relative pronoun or ending (aquam).
- spem -> spiritum: only next to sanctum.
- dies -> deus: only where "god" fits and "day" does not.
- tius -> tuis: only as a whole word, never as a word ending.
- l -> s: only where l makes a non-word and s makes a real word (rel -> res).
- o -> con: only where the letters up to the next space are a non-word that becomes a real word with con.
- xps/xpi/xpm -> christus/christi/christum. Never change xp inside a real word (expiando).
- Spell it quesumus, michi, eterne."""


# Isolated rubric abbreviations: expand AND tag, since they mark a new prayer.
RUBRIC_RULES = """
Isolated rubric abbreviations - expand, then tag as a function and start a new prayer:
Gru -> Graduale; V -> Versus (not when it is the numeral 5); Oster/official -> Offertorium; "p st com" -> Post communionem; Pes -> Per (only ending a prayer); eria -> alleluia (paschal context)."""


# --------------------------------------------------------------------------
# Function vocabularies (from ritus-client/public/data/functions.csv).
# "Sub < Parent" means Sub is a subfunction of Parent.
# --------------------------------------------------------------------------
FUNCTIONS_FULL = """
Prayer functions (use these names in <func>; "A < B" means A is a subfunction of B):
Epistola, Tropus, Troped Kyrie < Tropus, Troped Sanctus < Tropus, Troped Agnus dei < Tropus, Troped Ite missa est < Tropus, Troped Alleluia < Tropus, Troped Benedicamus domino < Tropus, Troped Communion < Tropus, Troped Gloria < Tropus, Troped Introit < Tropus, Troped Offertory < Tropus, Antiphon, Antiphon verse, Benedicamus domino, Varia, Varia within Holy Week, Hymn, Hymn verse, Litany, Pater noster, Sequence, Ite missa est, Agnus dei, Sanctus, Credo, Gloria, Kyrie, Communion, Communion verse, Offertory, Offertory verse, Alleluia, Tract, Tract verse, Gradual, Gradual verse, Introit, Introit verse, Super oblata, Sermo, Homilia, Litania, Hymnus, Responsorium, Versus Responsorii < Responsorium, Evangelium, Communio, Versus Communionis < Communio, Offertorium, Versus Offertorii < Offertorium, Sequentia, Alleluia, Versus Alleluiaticus < Alleluia, Tractus, Versus Tractus < Tractus, Formula, Versiculus, Graduale, Versus Gradualis < Graduale, Introitus, Versus Introitus < Introitus, Apologia, Ordo feriae quintae, Scrutinium, Breuiarum apostolorum, Iudicium Paenitentiale, Rubrica, Per ipsum, Per haec omnia, Nobis quoque peccatoribus, Supplices te rogamus, Supra que, Unde et memores, Quam oblationem, Memento Domine, Te igitur, Uere dignum et iustum est, Sursum corda, Consecratio, Qui pridie, Expositio praefatio symboli, Expositio euangeliorum, Memento, Hanc igitur, Ordinatio, Ordo de sabbato sancto, Ordo baptismi, Oratio sollemnis, Ordo de feria sexta, Ordo de feria quinta, Ordo paenitentiae, Exorcismus, Ad populum, Post communionem, Prophetia < Lectio, Lectio, Exsultet, Oratio, Calendarium, Canon missae, Infra actionem < Canon missae, Psalmus, Versus, Antiphona, Sanctus, Capitulum, Benedictio, Super populum, Communicantes, Agnus dei, Martirologium, Ad complendum, Prefatio, Secreta, Collecta"""


FUNCTIONS_SHORT = """
Prayer functions (use these names in <func>; "A < B" means A is a subfunction of B):
Introitus, Versus Introitus < Introitus, Collecta, Lectio, Epistola, Graduale, Versus Gradualis < Graduale, Alleluia, Versus Alleluiaticus < Alleluia, Tractus, Sequentia, Evangelium, Offertorium, Versus Offertorii < Offertorium, Secreta, Prefatio, Canon missae, Infra actionem < Canon missae, Communicantes, Hanc igitur, Qui pridie, Unde et memores, Nobis quoque peccatoribus, Per ipsum, Pater noster, Agnus dei, Communio, Versus Communionis < Communio, Post communionem, Ad complendum, Super populum, Oratio, Psalmus, Versus, Antiphona, Responsorium, Rubrica, Benedictio, Hymnus, Sanctus, Kyrie, Gloria, Credo"""


BASE_NEW = """Fix OCR errors in medieval Latin liturgical text.
Rules:
- Fix only typos and OCR misreads. Do NOT add, invent, or remove words.
- Split merged words and merge incorrectly split words.
- Wrap rite/rubric names in <red></red> tags.
- Wrap prayer function names in <func></func> tags.
- Separate distinct prayers with the ⏎ character.
- Close all tags properly.
- Output ONLY the corrected text, nothing else."""


P1 = BASE_NEW + "\n" + CONTEXT_RULES + "\n" + RUBRIC_RULES
P2 = P1 + "\n" + FUNCTIONS_FULL
P3 = P1 + "\n" + FUNCTIONS_SHORT

VARIANTS = {
    "P0_current": P0,
    "P1_context": P1,
    "P2_ctx_fullfunc": P2,
    "P3_ctx_shortfunc": P3,
}

if __name__ == "__main__":
    for name, p in VARIANTS.items():
        print(f"{name:>18}: {len(p):>5} chars, ~{len(p)//4:>4} tokens (rough)")
