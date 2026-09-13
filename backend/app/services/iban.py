"""الآيبان: توحيد صيغته والتحقق منه قبل الحفظ.

رقم خاطئ هنا يعني راتباً يُحوَّل إلى حساب غيره، فالتحقق ليس ترفاً. نتحقق من
الطول وصيغة الدولة ثم من رقم التحقق (mod-97) وهو المعيار الدولي ISO 13616.
"""
from __future__ import annotations

# أطوال الآيبان للدول الشائعة في المنطقة (الباقي يُقبل بالتحقق الحسابي وحده)
LENGTHS = {
    "SA": 24, "AE": 23, "KW": 30, "QA": 29, "BH": 22, "OM": 23,
    "JO": 30, "EG": 29, "YE": 30, "SD": 18, "LB": 28, "TR": 26,
}


def normalize(value: str | None) -> str:
    """يحذف المسافات والفواصل ويوحّد الحروف كبيرة."""
    return "".join(ch for ch in str(value or "").upper() if ch.isalnum())


def mod97(iban: str) -> int:
    """التحقق الحسابي المعياري: يُنقل أول حرفين للنهاية وتُحوَّل الحروف أرقاماً."""
    rotated = iban[4:] + iban[:4]
    digits = "".join(str(int(ch, 36)) for ch in rotated)
    remainder = 0
    for chunk_start in range(0, len(digits), 9):       # على دفعات تفادياً للأعداد الضخمة
        remainder = int(str(remainder) + digits[chunk_start:chunk_start + 9]) % 97
    return remainder


def problem(value: str | None) -> str | None:
    """سبب رفض الآيبان، أو None إن كان سليماً. القيمة الفارغة مقبولة."""
    iban = normalize(value)
    if not iban:
        return None
    if len(iban) < 15 or len(iban) > 34:
        return "الآيبان يجب أن يكون بين 15 و34 خانة"
    if not iban[:2].isalpha() or not iban[2:4].isdigit():
        return "صيغة الآيبان غير صحيحة — يبدأ برمز الدولة ثم رقمَي تحقق (مثال: SA03…)"
    expected = LENGTHS.get(iban[:2])
    if expected and len(iban) != expected:
        return f"آيبان {iban[:2]} يجب أن يكون {expected} خانة، والمُدخل {len(iban)}"
    if not iban[4:].isalnum():
        return "الآيبان يحتوي رموزاً غير مسموحة"
    if mod97(iban) != 1:
        return "رقم الآيبان غير صحيح — راجع الأرقام مع الموظف أو كشف حسابه"
    return None


def pretty(value: str | None) -> str:
    """عرضه على دفعات من أربع خانات ليسهل تدقيقه بالعين."""
    iban = normalize(value)
    return " ".join(iban[i:i + 4] for i in range(0, len(iban), 4))
