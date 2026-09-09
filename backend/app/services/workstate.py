"""آلة حالات الحضور: معنى كل بصمة يُحدَّد بحالة الموظف لا بترتيب البصمة.

الحالات ثلاث: خارج العمل، داخل العمل، في استراحة. وتتغيّر مباشرة بعد كل بصمة:

    خارج العمل  --بصمة-->  CLOCK_IN     -->  داخل العمل
    داخل العمل  --بصمة-->  BREAK_START  -->  في استراحة      (أثناء الوردية)
    داخل العمل  --بصمة-->  CLOCK_OUT    -->  خارج العمل      (ضمن وقت الانصراف)
    في استراحة  --بصمة-->  BREAK_END    -->  داخل العمل      (دائماً، مهما تأخرت)

فلا تُفهم البصمة الثانية استراحةً لأنها الثانية، ولا الرابعة انصرافاً لأنها الرابعة.
الانصراف وحده له قاعدته: وقت نهاية الوردية وسياسة الانصراف، حتى لا يتحوّل الخروج
لاستراحة إلى انصراف نهائي. وعدد الاستراحات في اليوم بلا حد ما لم تحدّه السياسة.

يُعاد بناء الأحداث من البصمات الخام في كل احتساب (Replay)، فتبقى النتيجة مطابقة
للبصمات مهما وصلت متأخرة أو صُحِّحت لاحقاً — والبصمة الخام لا تُحذف ولا تُستبدل.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from ..models import EventType, Punch, WorkState
from .policies import Policy

# نية صريحة قادمة من تطبيق الموظف (زر «بدء استراحة» مثلاً)
INTENT_EVENTS = {
    "clock_in": EventType.clock_in,
    "break_start": EventType.break_start,
    "break_end": EventType.break_end,
    "clock_out": EventType.clock_out,
}

# ما يُسمح به من كل حالة: نية لا تناسب الحالة تُهمل ويُستنتج الحدث
ALLOWED_FROM = {
    WorkState.out: {EventType.clock_in},
    WorkState.working: {EventType.break_start, EventType.clock_out},
    WorkState.on_break: {EventType.break_end},
}

STATE_AFTER = {
    EventType.clock_in: WorkState.working,
    EventType.break_start: WorkState.on_break,
    EventType.break_end: WorkState.working,
    EventType.clock_out: WorkState.out,
}

EVENT_LABELS = {
    EventType.clock_in: "حضور",
    EventType.break_start: "بدء استراحة",
    EventType.break_end: "عودة من الاستراحة",
    EventType.clock_out: "انصراف",
}

STATE_LABELS = {
    WorkState.out: "خارج العمل",
    WorkState.working: "داخل العمل",
    WorkState.on_break: "في استراحة",
}


@dataclass
class Event:
    """حدث مُفسَّر جاهز للحفظ."""

    punch: Punch
    event_time: datetime
    event_type: EventType
    state_before: WorkState
    state_after: WorkState


@dataclass
class BreakSpan:
    sequence: int
    start_at: datetime
    end_at: datetime | None = None

    @property
    def is_open(self) -> bool:
        return self.end_at is None

    @property
    def minutes(self) -> int:
        if self.end_at is None:
            return 0
        return max(0, int((self.end_at - self.start_at).total_seconds() // 60))


@dataclass
class DaySession:
    """حصيلة يوم واحد بعد إعادة تشغيل آلة الحالات."""

    events: list[Event] = field(default_factory=list)
    breaks: list[BreakSpan] = field(default_factory=list)
    ignored: list[Punch] = field(default_factory=list)   # بصمات مكررة مُهملة
    check_in: datetime | None = None
    check_out: datetime | None = None
    final_state: WorkState = WorkState.out

    @property
    def break_minutes(self) -> int:
        return sum(b.minutes for b in self.breaks)

    @property
    def break_count(self) -> int:
        return len(self.breaks)

    @property
    def open_break(self) -> BreakSpan | None:
        return next((b for b in self.breaks if b.is_open), None)

    @property
    def presence_minutes(self) -> int:
        """إجمالي مدة وجوده في مقر العمل: من الحضور إلى الانصراف."""
        if not self.check_in or not self.check_out:
            return 0
        return max(0, int((self.check_out - self.check_in).total_seconds() // 60))

    def overrun_minutes(self, policy: Policy) -> int:
        """التجاوز عن إجمالي الاستراحة المسموح (بعد دقائق السماح)."""
        limit = policy.break_limit
        return max(0, self.break_minutes - limit) if limit else 0

    def punches_count(self) -> int:
        return len(self.events)


def classify(
    state: WorkState,
    punch: Punch,
    scheduled_out: datetime,
    policy: Policy,
) -> EventType:
    """يحدّد معنى البصمة من حالة الموظف ووقت الوردية وسياسة الانصراف."""
    intent = INTENT_EVENTS.get((punch.intent or "").strip().lower())
    if intent is not None and intent in ALLOWED_FROM[state]:
        return intent

    if state is WorkState.out:
        return EventType.clock_in
    if state is WorkState.on_break:
        # العودة من الاستراحة دائماً — التأخر عن المسموح يُسجَّل تجاوزاً ولا يُمنع
        return EventType.break_end

    # داخل العمل: انصراف فقط ضمن وقت الانصراف المعتمد، وإلا فهي استراحة
    clock_out_from = scheduled_out - timedelta(minutes=max(0, policy.clock_out_from_minutes))
    if punch.punch_time >= clock_out_from:
        return EventType.clock_out
    return EventType.break_start


def replay(
    punches: list[Punch],
    scheduled_out: datetime,
    policy: Policy,
) -> DaySession:
    """يعيد تشغيل بصمات اليوم بالترتيب الزمني وينتج أحداثه واستراحاته."""
    session = DaySession()
    state = WorkState.out
    last_accepted: datetime | None = None
    debounce = timedelta(seconds=max(0, policy.debounce_seconds))

    for punch in sorted(punches, key=lambda p: (p.punch_time, p.id or 0)):
        if punch.deleted_at is not None:
            continue
        # منع البصمات المكررة من خطأ الجهاز خلال ثوانٍ قليلة
        if last_accepted is not None and punch.punch_time - last_accepted < debounce:
            session.ignored.append(punch)
            continue

        event_type = classify(state, punch, scheduled_out, policy)
        after = STATE_AFTER[event_type]
        session.events.append(Event(punch, punch.punch_time, event_type, state, after))

        if event_type is EventType.clock_in and session.check_in is None:
            session.check_in = punch.punch_time
        elif event_type is EventType.clock_out:
            session.check_out = punch.punch_time
        elif event_type is EventType.break_start:
            session.breaks.append(
                BreakSpan(sequence=len(session.breaks) + 1, start_at=punch.punch_time)
            )
        elif event_type is EventType.break_end and session.breaks:
            session.breaks[-1].end_at = punch.punch_time

        state = after
        last_accepted = punch.punch_time

    session.final_state = state
    return session


def worked_minutes(session: DaySession, policy: Policy, fallback_break: int = 0) -> int:
    """ساعات العمل الفعلية = الانصراف − الحضور − إجمالي الاستراحات.

    إن لم يسجّل الموظف استراحات أصلاً نستعمل استراحة الوردية الثابتة (إن وُجدت)
    حفاظاً على سلوك الأجهزة التي لا ترسل بصمات استراحة.
    """
    presence = session.presence_minutes
    if not presence:
        return 0
    if not policy.deduct_breaks:
        return presence
    deduction = session.break_minutes if session.breaks else fallback_break
    return max(0, presence - deduction)


def state_of(events: list) -> WorkState:
    """حالة الموظف الآن من آخر حدث مسجَّل له."""
    return events[-1].state_after if events else WorkState.out


def work_date_of(punch_time: datetime, rules, day_hint: date | None = None) -> date:
    """يوم الوردية الذي تنتمي إليه البصمة (يراعي الورديات الليلية)."""
    if day_hint is not None:
        return day_hint
    day = punch_time.date()
    if rules.is_night:
        start, _ = rules.window(day)
        if punch_time < start:
            return day - timedelta(days=1)
    return day
