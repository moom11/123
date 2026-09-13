"""توقيع رقمي بلا خلفية: يُرفع كصورة عادية ويُحوَّل إلى PNG شفاف نظيف.

المشكلة العملية: التوقيع يُصوَّر بالجوال على ورقة بيضاء، فيأتي بخلفية وظلال
وهوامش. هنا نجعل الخلفية شفافة بحسب قتامة كل نقطة (لا بعتبة قاسية فتتشقّق
الحروف)، ثم نقصّ الهوامش الفارغة، فيظهر التوقيع في التقرير كأنه مكتوب عليه.
"""
from __future__ import annotations

import secrets
from io import BytesIO
from pathlib import Path

MAX_WIDTH = 900          # عرض كافٍ للطباعة بلا تضخيم الملف
INK_CUT = 120            # أقتم من هذا = حبر كامل العتامة
PAPER_CUT = 232          # أفتح من هذا = ورق يُمحى تماماً
PAD = 12                 # هامش صغير حول التوقيع بعد القصّ


class SignatureError(Exception):
    """سبب مفهوم يُعرض للمستخدم بدل خطأ تقني."""


def _alpha_curve(value: int) -> int:
    """من درجة الرمادي إلى شفافية: ورق ← صفر، حبر ← 255، وما بينهما تدرّج."""
    if value >= PAPER_CUT:
        return 0
    if value <= INK_CUT:
        return 255
    return round(255 * (PAPER_CUT - value) / (PAPER_CUT - INK_CUT))


def strip_background(content: bytes) -> bytes:
    """يعيد PNG شفافاً للتوقيع وحده، مقصوصاً على حدوده.

    ما كان أفتح من الورق يصير شفافاً، وما بينهما يأخذ شفافية متدرّجة فتبقى
    حواف الحروف ناعمة. والصورة التي لها شفافية أصلاً تُحترم كما هي.
    """
    try:
        from PIL import Image
    except ImportError as exc:      # pragma: no cover - الحزمة ضمن المتطلبات
        raise SignatureError("معالجة الصور غير متاحة على الخادم") from exc

    try:
        image = Image.open(BytesIO(content))
        image.load()
    except Exception as exc:
        raise SignatureError("تعذّرت قراءة الصورة — جرّب PNG أو JPG") from exc

    had_alpha = image.mode in ("RGBA", "LA") or "transparency" in image.info
    image = image.convert("RGBA")
    if image.width > MAX_WIDTH:
        ratio = MAX_WIDTH / image.width
        image = image.resize((MAX_WIDTH, max(1, round(image.height * ratio))), Image.LANCZOS)

    if not had_alpha:
        # الشفافية بحسب قتامة كل نقطة: الورق يُمحى، والحبر يبقى، وما بينهما
        # يتدرّج فتبقى حواف الحروف ناعمة لا مسنّنة. يُنفَّذ على مستوى الصورة
        # كلها دفعة واحدة فلا يبطئ الرفع مهما كبرت الصورة.
        image.putalpha(image.convert("L").point(_alpha_curve))

    box = image.getbbox()
    if box is None:
        raise SignatureError("الصورة فارغة — لم يُعثر على توقيع فيها")
    left, top, right, bottom = box
    image = image.crop((
        max(0, left - PAD), max(0, top - PAD),
        min(image.width, right + PAD), min(image.height, bottom + PAD),
    ))
    if image.width < 20 or image.height < 10:
        raise SignatureError("التوقيع صغير جداً أو غير واضح — صوّره من قرب على ورقة بيضاء")

    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def store(content: bytes, upload_dir: Path, prefix: str = "sign") -> str:
    """يعالج الصورة ويحفظها PNG شفافاً. يعيد اسم الملف المخزَّن."""
    processed = strip_background(content)
    name = f"{prefix}_{secrets.token_hex(6)}.png"
    (upload_dir / name).write_bytes(processed)
    return name


def data_uri(path: Path) -> str | None:
    """التوقيع مضمّناً في المستند نفسه، فلا ينكسر عند الطباعة أو الحفظ PDF."""
    import base64

    try:
        raw = path.read_bytes()
    except OSError:
        return None
    return "data:image/png;base64," + base64.b64encode(raw).decode("ascii")
