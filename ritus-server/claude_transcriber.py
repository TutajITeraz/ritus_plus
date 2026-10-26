"""Whole-page transcription with Claude (Anthropic API).

Unlike the kraken / TrOCR path, which segments a page into lines and
recognises them one by one, Claude is given the entire page image and returns
the finished marked-up text in one call: rubrics in <red>, functions in
<func>, sub-rubrics in <subrub>, "⏎" between prayers. That is the markup the
client's transcriptionRows.js parser consumes, so the output drops straight
into the existing table pipeline.

API keys are stored per user (ClaudeKey), encrypted at rest, and can be shared
with other users. Every call is logged to ClaudeUsage so the settings panel can
show the last 24h of tokens/spend. Anthropic exposes no endpoint for the
prepaid credit balance, so the "remaining credit" shown in the UI is an
estimate: the balance the owner typed in from the Console, minus what Ritus has
spent since.
"""

import base64
import hashlib
import io
import logging
import re
from datetime import datetime, timedelta

from PIL import Image as PILImage

from models import db, ClaudeKey, ClaudeKeyShare, ClaudeUsage

logger = logging.getLogger(__name__)

# model id -> (label, USD per 1M input tokens, USD per 1M output tokens).
# Cache reads cost 0.1x input, cache writes 1.25x input.
CLAUDE_MODELS = {
    "claude-sonnet-5-5": ("Claude Sonnet 5.5", 2.00, 10.00),
    "claude-opus-5-5": ("Claude Opus 5.5", 4.00, 20.00),
}


def _config(name, default):
    try:
        import config
        return getattr(config, name, default)
    except ImportError:
        return default


# Long edge of the image sent to Claude. Larger scans are downscaled (smaller
# ones left alone); image tokens grow with area, so this is the main cost knob.
MAX_IMAGE_EDGE = int(_config("CLAUDE_IMAGE_MAX_EDGE", 2200))
# Anthropic rejects images over 5 MB (base64-decoded).
MAX_IMAGE_BYTES = 4_800_000
# Thinking depth. Opus 5.5 always thinks, so effort is the only dial. Its
# API default is "medium", at which reading a dense hand came out noticeably
# worse (and the reasoning spilled into the answer), so default higher.
EFFORT = _config("CLAUDE_EFFORT", "high")
MAX_OUTPUT_TOKENS = 16000


class ClaudeError(Exception):
    """A failure with a message fit to show the user and an HTTP-ish status.
    401/402/403 mean the key itself is the problem, so retrying other pages
    with it is pointless (the batch runner stops on those)."""

    def __init__(self, message, status=500):
        super().__init__(message)
        self.status = status


def is_claude_model(model_name):
    return model_name in CLAUDE_MODELS


# --------------------------------------------------------------------------- #
# Key storage
# --------------------------------------------------------------------------- #

def _fernet():
    try:
        from cryptography.fernet import Fernet
    except ImportError:
        raise ClaudeError("Server is missing the 'cryptography' package (pip install cryptography)", 500)
    # Derived from SECRET_KEY unless a dedicated secret is configured. Changing
    # that secret makes stored keys undecryptable, so users would re-enter them.
    secret = _config("CLAUDE_KEY_SECRET", None) or _config("SECRET_KEY", "")
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(secret.encode("utf-8")).digest()))


def encrypt_key(api_key):
    return _fernet().encrypt(api_key.encode("utf-8")).decode("ascii")


def decrypt_key(token):
    from cryptography.fernet import InvalidToken
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except InvalidToken:
        raise ClaudeError("Stored Claude API key can no longer be decrypted - please enter it again", 401)


def key_hint(api_key):
    """Safe-to-display form: prefix and last four characters."""
    return f"{api_key[:7]}…{api_key[-4:]}" if len(api_key) > 12 else "…"


def resolve_key(user_id):
    """The key *user_id* transcribes with: their own, else one shared with them.

    Returns (ClaudeKey, source) with source "own" or "shared", or (None, None).
    """
    own = ClaudeKey.query.filter_by(owner_id=user_id).first()
    if own:
        return own, "own"
    shared = (
        ClaudeKey.query
        .outerjoin(ClaudeKeyShare, ClaudeKeyShare.key_id == ClaudeKey.id)
        .filter(db.or_(ClaudeKey.share_with_all.is_(True), ClaudeKeyShare.user_id == user_id))
        .order_by(ClaudeKey.id.asc())
        .first()
    )
    return (shared, "shared") if shared else (None, None)


def make_client(api_key):
    try:
        import anthropic
    except ImportError:
        raise ClaudeError("Server is missing the 'anthropic' package (pip install anthropic)", 500)
    return anthropic.Anthropic(api_key=api_key, max_retries=4, timeout=300.0)


def _api_error(exc):
    """Translate an anthropic exception into a ClaudeError."""
    import anthropic
    if isinstance(exc, anthropic.AuthenticationError):
        return ClaudeError("The Claude API key was rejected (invalid or revoked)", 401)
    if isinstance(exc, anthropic.PermissionDeniedError):
        return ClaudeError("The Claude API key is not allowed to use this model", 403)
    if isinstance(exc, anthropic.BadRequestError):
        msg = getattr(exc, "message", str(exc))
        if "credit balance" in msg.lower():
            return ClaudeError("The Claude account is out of credits - top it up in the Anthropic Console", 402)
        return ClaudeError(f"Claude rejected the request: {msg}", 400)
    if isinstance(exc, anthropic.RateLimitError):
        return ClaudeError("Claude rate limit reached - try again in a moment", 429)
    if isinstance(exc, anthropic.APIConnectionError):
        return ClaudeError("Could not reach the Claude API", 502)
    if isinstance(exc, anthropic.APIStatusError):
        return ClaudeError(f"Claude API error {exc.status_code}: {getattr(exc, 'message', exc)}", 502)
    return ClaudeError(f"Claude request failed: {exc}", 500)


def validate_key(api_key):
    """Raise ClaudeError if the key does not authenticate. Listing models is free."""
    import anthropic
    client = make_client(api_key)
    try:
        client.models.list(limit=1)
    except anthropic.APIError as e:
        raise _api_error(e)


# --------------------------------------------------------------------------- #
# Usage accounting
# --------------------------------------------------------------------------- #

def cost_usd(model, input_tokens, output_tokens, cache_read=0, cache_write=0):
    _label, in_price, out_price = CLAUDE_MODELS.get(model, (None, 0.0, 0.0))
    return (
        input_tokens * in_price
        + cache_read * in_price * 0.10
        + cache_write * in_price * 1.25
        + output_tokens * out_price
    ) / 1_000_000


def record_usage(key, user_id, model, usage):
    input_tokens = getattr(usage, "input_tokens", 0) or 0
    output_tokens = getattr(usage, "output_tokens", 0) or 0
    cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
    cache_write = getattr(usage, "cache_creation_input_tokens", 0) or 0
    db.session.add(ClaudeUsage(
        key_id=key.id, user_id=user_id, model=model,
        input_tokens=input_tokens, output_tokens=output_tokens,
        cache_read_tokens=cache_read, cache_write_tokens=cache_write,
        cost_usd=cost_usd(model, input_tokens, output_tokens, cache_read, cache_write),
    ))
    db.session.commit()


def _summarise(rows):
    return {
        "requests": len(rows),
        "input_tokens": sum(r.input_tokens + r.cache_read_tokens + r.cache_write_tokens for r in rows),
        "output_tokens": sum(r.output_tokens for r in rows),
        "cost_usd": round(sum(r.cost_usd for r in rows), 4),
    }


def _breakdown(rows):
    """Totals for *rows*, plus the same split per model and per user."""
    by_model, by_user = {}, {}
    for r in rows:
        by_model.setdefault(r.model, []).append(r)
        by_user.setdefault(r.user_id, []).append(r)
    return {
        "total": _summarise(rows),
        "by_model": {m: _summarise(rs) for m, rs in by_model.items()},
        "by_user": {uid: _summarise(rs) for uid, rs in by_user.items()},
    }


def usage_summary(key, hours=24):
    """Usage of *key* over the last *hours* and since the log was last reset."""
    rows = ClaudeUsage.query.filter(ClaudeUsage.key_id == key.id).all()
    since = datetime.utcnow() - timedelta(hours=hours)
    first = min((r.created_at for r in rows), default=None)
    return {
        "recent": _breakdown([r for r in rows if r.created_at >= since]),
        "all_time": _breakdown(rows),
        "first_at": first.isoformat() + "Z" if first else None,
    }


def reset_usage(key):
    """Clear the usage log of *key*. The credit estimate depends on that log,
    so it is first rebased to its current value."""
    credit = estimated_credit(key)
    if credit is not None:
        key.credit_balance_usd = credit["estimated_remaining_usd"]
        key.credit_balance_set_at = datetime.utcnow()
    ClaudeUsage.query.filter_by(key_id=key.id).delete()
    db.session.commit()


def estimated_credit(key):
    """Balance the owner entered minus what Ritus spent after that moment.
    None when no balance was ever entered. An estimate: spending on the same
    key outside Ritus is invisible to us."""
    if key.credit_balance_usd is None or key.credit_balance_set_at is None:
        return None
    spent = db.session.query(db.func.coalesce(db.func.sum(ClaudeUsage.cost_usd), 0.0)).filter(
        ClaudeUsage.key_id == key.id, ClaudeUsage.created_at >= key.credit_balance_set_at
    ).scalar()
    return {
        "basis_usd": key.credit_balance_usd,
        "basis_at": key.credit_balance_set_at.isoformat() + "Z",
        "spent_since_usd": round(spent, 4),
        "estimated_remaining_usd": round(max(0.0, key.credit_balance_usd - spent), 4),
    }


# --------------------------------------------------------------------------- #
# Prompt
# --------------------------------------------------------------------------- #

# Function names as used in eCatalogus (client/public/data/functions.csv).
# Subfunctions (verses etc.) are written in <func> too, with their own name.
SYSTEM_PROMPT = """You transcribe one page image of a medieval Latin liturgical manuscript (Mass books, sacramentaries, graduals, pontificals, benedictionals, ordines; up to ca. 1300) for a catalogue of liturgical formulas. Your transcription is parsed by a program into catalogue rows: rite name / sub-rubric / function / formula text.

## Output format
Think the page through before answering, not in the answer. The answer is ONLY the finished transcription between <transcription> and </transcription>, given once. Nothing outside those tags is kept, and everything inside them is saved as manuscript text - so inside them write no notes, no explanations of your choices, no remarks on spelling or legibility, no description of the page.

## Text
- Read in reading order. On two-column pages read the whole left column, then the right one. Ignore text of the facing page or a neighbouring leaf visible at the edge of the photo.
- Join the lines of a formula with single spaces (no line breaks) and rejoin words hyphenated at a line end.
- Resolve scribal abbreviations silently (dns -> dominus, ds -> deus, omps -> omnipotens, xps -> christus, scs -> sanctus, qs -> quesumus, p -> per/pro/prae by context, a stroke over a vowel -> m/n). Keep the manuscript's medieval spelling (michi, nichil, eterne, celi, penthecosten, e for ae). Write u for consonantal v and i for j (uobis, uere, euangelium, iustum).
- Copy what is written. Do not correct the Latin, do not complete a formula from memory, do not invent text. A formula given only as an incipit (cue) stays an incipit. If a word cannot be read, give your best reading; if there is none, write [...].
- Capitalise the first word of each formula and proper names. Punctuation light: comma, full stop.
- Skip folio/page numbers, catchwords, ruling, decoration, neumes and musical notation, later marginal notes and pen trials.

## Tags (use ONLY these three; they never nest and are always closed)
<red>...</red>  Rite name: the heading naming the feast, day, occasion or rite the following formulas belong to, normally in red or display capitals: <red>In uigilia pentecosten</red>, <red>De sancto spiritu</red>, <red>Dominica quarta</red>, <red>Benedictio in die ascensionis domini</red>, <red>Ordo baptismi</red>. A red initial letter, red touch-ups on capitals and red line fillers are NOT tags - write that letter as ordinary text.
<subrub>...</subrub>  Sub-rubric: any other heading or rubric line as written in the manuscript - a label naming a part of the rite, a reading's title, a station, an instruction or a cross-reference: <subrub>Lectio actuum apostolorum</subrub>, <subrub>Complendum</subrub>, <subrub>Ad uesperum</subrub>, <subrub>Ut supra in die penthecosten.</subrub>
<func>...</func>  Function: the standardised name of what the following formula is. You add it yourself from the catalogue list below - it does not have to be spelled out on the page. Write exactly one name from the list:
Introitus, Graduale, Alleluia, Tractus, Sequentia, Offertorium, Communio, Responsorium, Antiphona, Psalmus, Epistola, Lectio, Evangelium, Collecta, Oratio, Oratio sollemnis, Secreta, Super oblata, Prefatio, Sursum corda, Uere dignum et iustum est, Sanctus, Canon missae, Te igitur, Memento Domine, Communicantes, Hanc igitur, Quam oblationem, Qui pridie, Unde et memores, Supra que, Supplices te rogamus, Memento, Nobis quoque peccatoribus, Per ipsum, Per haec omnia, Pater noster, Agnus dei, Post communionem, Ad complendum, Super populum, Ad populum, Benedictio, Benedicamus domino, Ite missa est, Kyrie, Gloria, Credo, Hymnus, Litania, Capitulum, Versiculus, Exsultet, Exorcismus, Apologia, Scrutinium, Consecratio, Ordinatio, Expositio euangeliorum, Expositio praefatio symboli, Breuiarum apostolorum, Iudicium Paenitentiale, Ordo paenitentiae, Ordo de feria quinta, Ordo de feria sexta, Ordo de sabbato sancto, Prophetia, Sermo, Homilia, Calendarium, Martirologium, Formula, Tropus, Rubrica,
or a subfunction: Versus Introitus, Versus Gradualis, Versus Alleluiaticus, Versus Tractus, Versus Offertorii, Versus Communionis, Versus Responsorii, Versus, Infra actionem, Troped Kyrie, Troped Gloria, Troped Sanctus, Troped Agnus dei, Troped Introit, Troped Offertory, Troped Communion, Troped Alleluia.
Typical label abbreviations: In / Int = Introitus, Gr / R. Gr = Graduale, V / Vs = Versus (of the chant before it, e.g. Versus Introitus), All = Alleluia, Tr = Tractus, Of / Off = Offertorium, Co / Com = Communio, Or / Coll = Collecta, Sec / Super obl = Secreta, Pf / Praef / VD = Prefatio, Ad compl / Compl = Ad complendum, Post com / P com = Post communionem, Sup pop = Super populum, Ep = Epistola, Lc / Lect = Lectio, Ev / Sec. N. = Evangelium, Bn / Bened = Benedictio, Ant = Antiphona, Ps = Psalmus.

How to label a formula:
- The label on the page is only the function name or its abbreviation (Co, Off, Collecta) -> write just <func>Communio</func>.
- The label says more than, or something other than, the catalogue name (Complendum, Lectio actuum apostolorum, Super oblata) -> copy it as <subrub>, then add the <func>: <subrub>Complendum</subrub> <func>Ad complendum</func>.
- No label, but the type is clear (a collect after the introit chants, an episcopal blessing after its heading) -> add the <func> yourself. If the type is unclear, leave the formula without <func>.
- Put the <func> directly before the text of its formula. A function label written in red is still <func> (plus <subrub> per the rules above), never <red>.

## Separating formulas with ⏎
Write ⏎ after every unit: after each formula, after a rite name, after a sub-rubric that stands alone on its own line. Do NOT put ⏎ between a label (<subrub>/<func>) and the formula text it introduces. A new formula begins at:
- a large, coloured or decorated initial opening a line after a text has ended;
- the word after a closing formula or a concluding "Amen": "Per dominum nostrum ...", "Per omnia secula seculorum. Amen.", "Qui uiuis et regnas ...", "Per." ; in episcopal blessings each section ending in "Amen" is one formula, and the final "Quod ipse prestare dignetur ..." is a formula of its own;
- a new label.
An ordinary capital in running text, a line, column or page break, or a red touch-up on a capital does NOT begin a new formula. Text continuing from the previous page is written first, with no label, and ended with ⏎. Put no ⏎ at the very end of the page (page ends are handled separately).

## Example of the expected answer (from a missal page)
<transcription>huius oblationis hostiam et per eam nosmetipsos tibi perfice munus eternum. ⏎ <subrub>Prefatio</subrub> <func>Prefatio</func> Quia cum unigenito. ⏎ <func>Communio</func> Benedicimus deum celi et coram omnibus uiuentibus confitebimur ei quia fecit nobiscum misericordiam suam. ⏎ <subrub>Complendum</subrub> <func>Ad complendum</func> Proficiat nobis ad salutem corporis et anime domine deus huius sacramenti susceptio et sempiterne sancte trinitatis confessio. Per. ⏎ <red>De sancto spiritu</red> ⏎ <func>Introitus</func> Spiritus domini. ⏎ <func>Versus Introitus</func> Omnium est enim. ⏎ <subrub>Ut supra in die penthecosten.</subrub> ⏎ <func>Collecta</func> Deus qui corda fidelium sancti spiritus illustratione. ⏎ <subrub>Lectio actuum apostolorum</subrub> <func>Lectio</func> In diebus illis. Cum audissent apostoli qui erant Ierosolimis quod recepit Samaria uerbum dei</transcription>

And from a benedictional page:
<transcription>uobis aduersa omnia que peccatorum retributione meremini auertat. Et donum in uos spiritus paracliti infundat. ⏎ <subrub>Responsio</subrub> Quod ipse prestare. ⏎ <red>Benedictio in die ascensionis domini</red> ⏎ <func>Benedictio</func> Benedicat uobis omnipotens deus cuius unigenitus hodierna die celorum alta penetrauit, et uobis ubi ille est ascendendi aditum patefecit. Amen. ⏎ Concedat propitius ut sicut post resurrectionem suam discipulis uisus est manifestus, ita uobis in iudicium ueniens uideatur placatus. Amen.</transcription>"""


# --------------------------------------------------------------------------- #
# Transcription
# --------------------------------------------------------------------------- #

def _prepare_image(path):
    """JPEG bytes of the page, downscaled to MAX_IMAGE_EDGE and under 5 MB."""
    img = PILImage.open(path)
    if img.mode != "RGB":
        img = img.convert("RGB")
    long_edge = max(img.size)
    if long_edge > MAX_IMAGE_EDGE:
        scale = MAX_IMAGE_EDGE / long_edge
        img = img.resize((round(img.width * scale), round(img.height * scale)), PILImage.LANCZOS)
    quality = 90
    while True:
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality)
        if buf.tell() <= MAX_IMAGE_BYTES or quality <= 50:
            return buf.getvalue()
        quality -= 10


def _extract(text):
    """The part of the answer between <transcription> tags. Anything outside
    them (a stray remark about the page, a first draft) is dropped; if the
    tags are missing altogether the whole answer is used."""
    blocks = re.findall(r"<transcription>(.*?)(?:</transcription>|$)", text, re.S)
    return blocks[-1] if blocks else text


def _clean(text):
    text = _extract(text).strip()
    text = re.sub(r"^```[a-z]*\n?|\n?```$", "", text).strip()
    text = text.replace("<subfunc>", "<func>").replace("</subfunc>", "</func>")
    text = re.sub(r"\s*\n\s*", " ", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\s*⏎\s*", " ⏎ ", text).strip()
    text = re.sub(r"^(⏎\s*)+|(\s*⏎)+$", "", text).strip()
    # An unclosed tag would make the client parser discard the rest of the
    # page, so drop a dangling opener instead of passing it on.
    for tag in ("red", "func", "subrub"):
        opened = len(re.findall(rf"<{tag}>", text))
        closed = len(re.findall(rf"</{tag}>", text))
        if opened > closed:
            idx = text.rfind(f"<{tag}>")
            text = text[:idx] + text[idx + len(tag) + 2:]
        elif closed > opened:
            idx = text.rfind(f"</{tag}>")
            text = text[:idx] + text[idx + len(tag) + 3:]
    return text


def transcribe_page(image_path, model, user_id):
    """Transcribe one page image. Returns the marked-up text.

    Needs an application context (key lookup and usage logging use the DB).
    Raises ClaudeError."""
    if model not in CLAUDE_MODELS:
        raise ClaudeError(f"Unknown Claude model: {model}", 400)
    key, _source = resolve_key(user_id)
    if key is None:
        raise ClaudeError("No Claude API key available - add one (or ask a colleague to share theirs) in Settings", 402)
    api_key = decrypt_key(key.encrypted_key)

    import anthropic
    client = make_client(api_key)
    image_b64 = base64.standard_b64encode(_prepare_image(image_path)).decode("ascii")
    try:
        response = client.messages.create(
            model=model,
            max_tokens=MAX_OUTPUT_TOKENS,
            # No temperature/top_p: these models reject non-default sampling.
            # Reasoning goes to (omitted) thinking blocks, not to the answer.
            thinking={"type": "adaptive"},
            output_config={"effort": EFFORT},
            system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": image_b64}},
                    {"type": "text", "text": "Transcribe this page. Answer only with <transcription>...</transcription>."},
                ],
            }],
        )
    except anthropic.APIError as e:
        raise _api_error(e)

    # Tokens were spent even if the answer turns out unusable.
    record_usage(key, user_id, model, response.usage)

    if response.stop_reason == "refusal":
        raise ClaudeError("Claude declined to transcribe this page", 422)
    if response.stop_reason == "max_tokens":
        raise ClaudeError("Claude's answer was cut off (page too long)", 422)
    text = "".join(b.text for b in response.content if b.type == "text")
    return _clean(text)
