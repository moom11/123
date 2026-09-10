/* ==========================================================================
   الترجمة: عربي / English
   القاموس يربط النص العربي كما هو في الواجهة بمقابله الإنجليزي، وتُترجم الصفحة
   بعد رسمها (نصوص العناصر + placeholder/title)، فما لا يوجد له مقابل يبقى عربياً.
   ========================================================================== */
const I18N_EN = {
  // ------- التنقل والصفحات -------
  'لوحة المؤشرات': 'Dashboard', 'الحضور اليومي': 'Daily Attendance', 'سجل البصمات': 'Punch Log',
  'الإجازات': 'Leaves', 'إجازاتي': 'My Leaves', 'أرصدة الإجازات': 'Leave Balances',
  'المخالفات': 'Violations', 'الرواتب': 'Payroll', 'السلف': 'Loans', 'الموظفون': 'Employees',
  'الوثائق': 'Documents', 'وثائق الموظفين': 'Employee Documents', 'أجهزة البصمة': 'Devices',
  'التقارير': 'Reports', 'الإعدادات': 'Settings', 'حسابي': 'My Account', 'بياناتي': 'My Info',
  'ملف الموظف': 'Employee Profile', 'عام': 'General', 'الحضور': 'Attendance',
  'شؤون الموظفين': 'HR Affairs', 'الإدارة': 'Administration', 'المزيد': 'More', 'بصمة': 'Punch',
  'نظام الموارد البشرية': 'HR System', 'الموارد البشرية': 'Human Resources',
  'الحضور والانصراف والإجازات': 'Attendance & Leaves',

  // ------- عام وأزرار -------
  'حفظ': 'Save', 'إلغاء': 'Cancel', 'حذف': 'Delete', 'تعديل': 'Edit', 'عرض': 'Show',
  'إغلاق': 'Close', 'تحديث': 'Refresh', 'بحث': 'Search', 'إضافة': 'Add', 'إنشاء': 'Create',
  'اعتماد': 'Approve', 'رفض': 'Reject', 'إرفاق': 'Attach', 'المرفق': 'Attachment',
  'رجوع': 'Back', 'خروج': 'Sign out', 'تسجيل الخروج': 'Sign out', 'دخول': 'Sign in',
  'الكل': 'All', 'نعم': 'Yes', 'لا': 'No', 'من': 'From', 'إلى': 'To', 'أو': 'or',
  'اختياري': 'Optional', 'ريال': 'SAR', 'موظف': 'employee', 'الملف': 'Profile',
  'مفعّل': 'Enabled', 'معطّل': 'Disabled', 'مفعّلة': 'Enabled', 'معطّلة': 'Disabled',
  'إيقاف': 'Disable', 'بطاقات': 'Cards', 'جدول': 'Table', 'تصدير CSV': 'Export CSV',
  'جارٍ التحميل…': 'Loading…', 'لا توجد بيانات': 'No data', 'صفحة غير متاحة': 'Page unavailable',
  'إجراءات': 'Actions', 'إجراءات سريعة': 'Quick actions', 'تاريخ اليوم': 'Today',

  // ------- تسجيل الدخول -------
  'اسم المستخدم أو رقم الجوال': 'Username or mobile number',
  'اسم المستخدم': 'Username', 'كلمة المرور': 'Password',
  'كلمة المرور الحالية': 'Current password', 'كلمة المرور الجديدة': 'New password',
  'كلمة المرور الجديدة (٦ أحرف فأكثر)': 'New password (6+ characters)',
  'كلمة المرور المؤقتة': 'Temporary password', 'حفظ ومتابعة': 'Save and continue',
  'تغيير كلمة المرور': 'Change password', 'بيانات الحساب': 'Account details',
  'المستخدم:': 'User:', 'الصلاحية:': 'Role:', 'الموظف المرتبط:': 'Linked employee:',
  'غير مرتبط': 'Not linked',

  // ------- الحالات -------
  'حاضر': 'Present', 'متأخر': 'Late', 'غائب': 'Absent', 'غياب': 'Absent', 'إجازة': 'Leave',
  // ------------------------------ المخالفات والجزاءات ------------------------------
  'المخالفات': 'Violations', 'المخالفات والجزاءات': 'Violations & penalties',
  'تسجيل مخالفة': 'Record violation', 'نوع المخالفة': 'Violation type',
  'تاريخ المخالفة': 'Violation date', 'رقم التكرار': 'Repetition no.',
  'الجزاء': 'Penalty', 'قيمة الخصم': 'Deduction amount', 'الوصف': 'Description',
  'إقرار بالاطلاع': 'Acknowledge', 'تقديم تظلّم': 'File objection', 'تظلّم': 'Objection',
  'اعتماد المخالفة': 'Approve violation', 'إلغاء المخالفة': 'Cancel violation',
  'بانتظار إقرار الموظف': 'Awaiting acknowledgement', 'أقرّ بالاطلاع': 'Acknowledged',
  'تظلّم الموظف': 'Objected', 'معتمدة': 'Approved', 'ملغاة': 'Cancelled',
  'إنذار كتابي': 'Written warning', 'خصم نسبة من أجر يوم': 'Percent of daily wage',
  'خصم أجر أيام': 'Days of wage', 'إيقاف بدون أجر': 'Unpaid suspension',
  'الفصل من العمل': 'Termination',
  'عدم الالتزام بالزي الرسمي أو المظهر اللائق': 'Dress code / appearance',
  'عدم الالتزام بالنظافة الشخصية أو نظافة موقع العمل': 'Personal or site hygiene',
  'عدم التواجد في المكان المخصص للعمل أثناء الدوام': 'Absent from workstation',
  'مغادرة موقع العمل قبل نهاية الدوام بدون إذن': 'Leaving site without permission',
  'عدم استخدام أدوات ومعدات السلامة المقررة': 'Not using safety equipment',
  'التدخين في الأماكن الممنوعة': 'Smoking in prohibited areas',
  'تجاوز وقت الاستراحة المسموح': 'Break time overrun',
  'الانشغال بالجوال أو أعمال شخصية أثناء ساعات العمل': 'Phone / personal use at work',
  'سوء التعامل مع العملاء أو الزملاء': 'Misconduct with customers or colleagues',
  'رفض تنفيذ تعليمات العمل المشروعة': 'Refusing lawful instructions',
  'إتلاف الممتلكات أو سوء استخدامها': 'Damaging or misusing property',
  'المظهر والزي': 'Appearance', 'النظافة والسلامة': 'Hygiene & safety',
  'الالتزام بموقع العمل': 'Worksite compliance', 'سلوك عام': 'General conduct',
  'الانضباط الوظيفي': 'Work discipline',

  // ------------------------------ التنبيهات والإشعارات ------------------------------
  'الإشعارات': 'Notifications', 'التنبيهات': 'Alerts',
  'التنبيهات وإشعارات الجوال': 'Alerts & mobile notifications',
  'تعليم الكل كمقروء': 'Mark all as read', 'لا إشعارات': 'No notifications',
  'تنبيه الغياب والتأخير': 'Absence & lateness alert',
  'تجاوز وقت الاستراحة': 'Break overrun', 'تجاوزت وقت الاستراحة': 'You exceeded your break',
  'استراحة مفتوحة': 'Open break', 'سلفة بانتظار الاعتماد': 'Loan awaiting approval',
  'طلب سلفة جديد': 'New loan request', 'اعتُمدت سلفتك — أقرّ باستلامها': 'Loan approved — confirm receipt',
  'رُفض طلب السلفة': 'Loan request rejected', 'إقرار باستلام سلفة': 'Loan receipt confirmed',
  'طلب «نسيت البصمة»': 'Missed punch request', 'اعتُمد طلب البصمة': 'Punch request approved',
  'رُفض طلب البصمة': 'Punch request rejected',
  'فاتورة مشتريات على حسابك': 'Purchase invoice on your account',
  'قسيمة راتب جاهزة': 'Payslip ready', 'إرسال إشعار تجريبي': 'Send test notification',

  // ------------------------------ المشتريات والسلف والطلبات ------------------------------
  'مشتريات الموظفين': 'Employee purchases', 'مشتريات': 'Purchases',
  'تسجيل فاتورة': 'Record invoice', 'الفواتير': 'Invoices', 'البيان': 'Details',
  'رقم الفاتورة': 'Invoice no.', 'فواتير الشهر': 'Invoices this month',
  'إجمالي الخصم': 'Total deduction', 'تُخصم': 'Deducted', 'سبب الإلغاء (إلزامي)': 'Cancellation reason (required)',
  'طلبات البصمة': 'Punch requests', 'طلب سلفة': 'Request loan',
  'طلب تسجيل بصمة فائتة': 'Missed punch request', 'نسيت البصمة؟': 'Forgot to punch?',
  'وقت البصمة الفائتة': 'Missed punch time', 'الوقت المطلوب': 'Requested time',
  'أقرّ باستلام السلفة': 'Confirm loan receipt', 'بانتظار الاعتماد': 'Awaiting approval',
  'بانتظار إقرار الاستلام': 'Awaiting receipt confirmation', 'سارية': 'Active',
  'مسدّدة': 'Settled', 'راتبي حتى اليوم': 'My salary to date',
  'المستحق حتى اليوم': 'Earned to date', 'الخصومات حتى اليوم': 'Deductions to date',
  'الصافي التقديري الآن': 'Estimated net now', 'راتب الشهر كاملاً': 'Full month salary',
  'طباعة الجدول': 'Print table', 'جدول الرواتب': 'Payroll table',

  // حالات الموظف والاستراحات
  'داخل العمل': 'At work', 'في استراحة': 'On break', 'خارج العمل': 'Off duty',
  'أنت الآن داخل العمل': 'You are at work', 'أنت الآن في استراحة': 'You are on break',
  'أنت الآن خارج العمل': 'You are off duty', 'تحتاج مراجعة': 'Needs review',
  'حضور': 'Clock in', 'انصراف': 'Clock out',
  'بدء استراحة': 'Start break', 'عودة من الاستراحة': 'End break',
  'إنهاء الاستراحة': 'End break', 'الاستراحات': 'Breaks', 'استراحة': 'Break',
  'تجاوز الاستراحة': 'Break overrun', 'استراحة مفتوحة': 'Open break',
  'الحالة الآن': 'Live status', 'في المقر': 'On site', 'ساعات فعلية': 'Net hours',
  'سياسة الحضور والاستراحة': 'Attendance & break policy',
  'عطلة رسمية': 'Public holiday', 'راحة أسبوعية': 'Weekly rest', 'انصراف ناقص': 'Missing out',
  'لم يحن بعد': 'Upcoming', 'قيد الاعتماد': 'Pending', 'معتمدة': 'Approved', 'مرفوضة': 'Rejected',
  'ملغاة': 'Cancelled', 'على رأس العمل': 'Active', 'موقوف': 'Suspended',
  'منتهية خدمته': 'Terminated', 'سارية': 'Active', 'مسدّدة': 'Settled', 'معتمد': 'Approved',
  'مسودة': 'Draft', 'منتهية': 'Expired', 'إجازة / عطلة': 'Leave / holiday',
  'بانتظار إقرار الموظف': 'Awaiting acknowledgement', 'أقرّ بالاطلاع': 'Acknowledged',
  'تظلّم الموظف': 'Objected', 'مدير النظام': 'Administrator', 'موارد بشرية': 'HR',
  'مدير إدارة': 'Manager',

  // ------- لوحة المؤشرات -------
  'إجمالي الموظفين': 'Total employees', 'الحضور اليوم': 'Present today', 'متأخرون': 'Late',
  'في إجازة': 'On leave', 'طلبات إجازة معلّقة': 'Pending leave requests',
  'طلبات إجازتي المعلّقة': 'My pending requests', 'حالتي اليوم': 'My status today',
  'الحضور خلال آخر ٧ أيام': 'Attendance — last 7 days',
  'حضوري خلال آخر ٧ أيام': 'My attendance — last 7 days',
  'توزيع الموظفين حسب الإدارة': 'Employees by department', 'حضور اليوم': "Today's attendance",
  'سجلي اليوم': 'My record today', 'فتح الكشف اليومي': 'Open daily sheet',
  'فتح سجل حضوري': 'Open my attendance', 'متصلة خلال ٢٤ ساعة': 'Online in last 24h',
  'تسجيل حضوري من التطبيق': 'Punch from the app',
  'تسجيل حضور / انصراف': 'Check in / out', 'التحقق من موقعي': 'Check my location',
  'يجب أن تكون داخل نطاق موقع العمل المعتمد عند التسجيل.':
    'You must be inside the approved work site to punch.',
  'جارٍ تحديد موقعك…': 'Locating you…', 'جارٍ تحديد الموقع…': 'Locating…',
  'إضافة موظف': 'Add employee', 'اعتماد الإجازات': 'Approve leaves',
  'تسجيل مخالفة': 'Record violation', 'مسير الرواتب': 'Payroll run',
  'إصدار تقرير': 'Run report', 'إضافة وثيقة': 'Add document', 'طلب إجازة': 'Request leave',
  'سجل حضوري': 'My attendance', 'قسائم رواتبي': 'My payslips', 'وثائقي': 'My documents',
  'طلبات فريقي': 'My team requests', 'حضور الفريق': 'Team attendance',

  // ------- الحضور -------
  'التاريخ': 'Date', 'الانصراف': 'Check-out', 'ساعات': 'Hours', 'تأخير (د)': 'Late (min)',
  'خروج مبكر (د)': 'Early out (min)', 'إضافي (د)': 'Overtime (min)', 'الحالة': 'Status',
  'ملاحظة': 'Note', 'الموظف': 'Employee', 'رقم الموظف': 'Employee no.', 'الاسم': 'Name',
  'كشف الحضور': 'Attendance sheet', 'كشف موظف لفترة': 'Employee sheet for a period',
  'اختر التاريخ ثم اضغط «عرض»': 'Pick a date then press Show',
  'إعادة احتساب': 'Recalculate', 'بصمة يدوية': 'Manual punch', 'الوقت': 'Time',
  'التاريخ والوقت': 'Date & time', 'المصدر': 'Source', 'الجهاز/الموقع': 'Device / site',
  'البصمات الخام': 'Raw punches', 'تفصيل أيام الشهر': 'Month detail',

  // ------- الإجازات -------
  'طلب إجازة جديد': 'New leave request', 'طلبات الإجازة': 'Leave requests', 'طلباتي': 'My requests',
  'نوع الإجازة': 'Leave type', 'من تاريخ': 'From date', 'إلى تاريخ': 'To date',
  'السبب': 'Reason', 'الأيام': 'Days', 'إرسال الطلب': 'Submit request',
  'الأرصدة': 'Balances', 'المستحق': 'Entitled', 'مرحّل': 'Carried over',
  'المستخدم': 'Used', 'المتبقي': 'Remaining', 'رصيدي لعام': 'My balance for',
  'تظهر هنا طلباتك ورصيدك أنت فقط.': 'Only your own requests and balance appear here.',
  'لا توجد أرصدة مسجّلة': 'No balances recorded',
  'لم تقدّم أي طلب إجازة بعد': 'You have not requested any leave yet',
  'لا توجد طلبات مطابقة': 'No matching requests', 'إجازة سنوية': 'Annual leave',
  'إجازة مرضية': 'Sick leave', 'إجازة اضطرارية': 'Emergency leave',
  'إجازة بدون راتب': 'Unpaid leave', 'إجازة وضع': 'Maternity leave', 'إجازة زواج': 'Marriage leave',

  // ------- الموظفون والملف -------
  'قائمة الموظفين': 'Employee list', 'المسمى الوظيفي': 'Job title', 'الوردية': 'Shift',
  'تاريخ التعيين': 'Hire date', 'مدة الخدمة': 'Service', 'حساب دخول': 'Login account',
  'بدون إدارة': 'No department', 'بدون مسمى': 'No title', 'خدمة:': 'Service:',
  'الهوية / الإقامة': 'ID / Iqama', 'الجوال': 'Mobile', 'البريد': 'Email',
  'رقم الهوية / الإقامة': 'ID / Iqama number', 'رقم الجوال': 'Mobile number',
  'البريد الإلكتروني': 'Email address', 'حفظ بياناتي': 'Save my info',
  'بياناتي الشخصية': 'My personal info', 'بيانات وظيفتي': 'My job details',
  'أيام الراحة الأسبوعية': 'Weekly rest days', 'حسب الوردية': 'As per shift',
  'الراتب الأساسي': 'Basic salary', 'البدلات': 'Allowances', 'الراتب الكامل': 'Total salary',
  'موقع العمل': 'Work site', 'نظرة عامة': 'Overview', 'الجدول الزمني': 'Timeline',
  'الراتب': 'Salary', 'البيانات الأساسية': 'Basic details', 'مؤشرات الملف': 'Profile metrics',
  'أهم الأحداث': 'Key events', 'مكوّنات الراتب': 'Salary components',
  'أيام الحضور': 'Days present', 'أيام الغياب': 'Days absent', 'دقائق التأخير': 'Late minutes',
  'أيام الحضور هذا الشهر': 'Days present this month', 'خلال الشهر الجاري': 'This month',
  'مجموع الشهر': 'Month total', 'نسبة الحضور هذا الشهر': 'Attendance rate this month',
  'تعديل البيانات': 'Edit details', 'لا يوجد موظفون مطابقون': 'No matching employees',

  // ------- الرواتب والسلف -------
  'احتساب المسير': 'Run payroll', 'مسيّرات الرواتب': 'Payroll runs', 'آخر مسير': 'Latest run',
  'الأساسي': 'Basic', 'الأساسي + البدلات': 'Basic + allowances', 'الخصومات': 'Deductions',
  'صافي المسير': 'Net total', 'عرض القسائم': 'View payslips', 'الفترة': 'Period',
  'الصافي': 'Net', 'صافي الراتب': 'Net salary', 'قسط السلفة': 'Loan instalment',
  'قسط سلفة': 'Loan instalment', 'بدل الإضافي': 'Overtime pay', 'بدل إضافي': 'Overtime',
  'خصم غياب': 'Absence deduction', 'خصم تأخير': 'Late deduction',
  'إجازة بلا راتب': 'Unpaid leave', 'خصم مخالفات': 'Violation deduction',
  'إضافات': 'Additions', 'خصومات': 'Deductions', 'قسائم رواتبي ': 'My payslips',
  'الشهر': 'Month', 'السنة': 'Year', 'تسجيل سلفة': 'Add loan', 'سلف سارية': 'Active loans',
  'إجمالي المتبقي': 'Outstanding total', 'المسدّد': 'Paid', 'أقساط هذا الشهر': 'This month instalments',
  'المبلغ': 'Amount', 'القسط': 'Instalment', 'الأقساط': 'Instalments', 'يبدأ': 'Starts',
  'مبلغ السلفة': 'Loan amount', 'القسط الشهري': 'Monthly instalment',
  'يبدأ الخصم من شهر': 'Deduction starts in', 'تسديد كامل': 'Mark settled',
  'القسط يُخصم تلقائياً في مسير الرواتب الشهري.':
    'The instalment is deducted automatically in the monthly payroll run.',
  'لا توجد سلف مسجّلة': 'No loans recorded', 'لا توجد سلف على راتبك': 'You have no loans',
  'قسيمة': 'Payslip', 'قسيمتي': 'My payslip', 'القسائم PDF': 'Payslips PDF',
  'لا توجد قسائم معتمدة بعد': 'No approved payslips yet',

  // ------- المخالفات والوثائق -------
  'سجل المخالفات': 'Violation log', 'المخالفة': 'Violation', 'التكرار': 'Repetition',
  'الجزاء': 'Penalty', 'الخصم': 'Deduction', 'إقرار بالاطلاع': 'Acknowledge', 'تظلّم': 'Object',
  'لا توجد مخالفات مسجلة': 'No violations recorded', 'لا توجد مخالفات — سجل نظيف': 'No violations — clean record',
  'نوع الوثيقة': 'Document type', 'رقم الوثيقة': 'Document number', 'تاريخ الإصدار': 'Issue date',
  'تاريخ الانتهاء': 'Expiry date', 'لا توجد وثائق': 'No documents',
  'لا توجد وثائق مسجّلة': 'No documents recorded', 'إقامة': 'Iqama', 'جواز سفر': 'Passport',
  'عقد عمل': 'Employment contract', 'رخصة قيادة': 'Driving licence',
  'شهادة صحية': 'Health certificate', 'بطاقة تأمين': 'Insurance card', 'مؤهل علمي': 'Qualification',
  'أخرى': 'Other', 'إدارة الوثائق': 'Manage documents',

  // ------- الإشعارات -------
  'مركز التنبيهات': 'Notification centre', 'الإشعارات': 'Notifications',
  'لا توجد إشعارات': 'No notifications', 'تعليم الكل كمقروء': 'Mark all as read',
  'غير مقروء': 'Unread', 'إشعارات الجوال': 'Mobile notifications',
  'تفعيل على هذا الجهاز': 'Enable on this device', 'إرسال إشعار تجريبي': 'Send test notification',
  'مفعّل على هذا الجهاز': 'Enabled on this device',
  'غير مفعّل على هذا الجهاز': 'Not enabled on this device', 'غير مدعوم': 'Not supported',

  // ------- رسائل -------
  'تم الحفظ': 'Saved', 'تم الحذف': 'Deleted', 'تم التعديل': 'Updated',
  'تم إرسال الطلب': 'Request sent', 'تم تنفيذ الإجراء': 'Done', 'تم رفع المرفق': 'Attachment uploaded',
  'تم حفظ بياناتك': 'Your details were saved', 'تم تغيير كلمة المرور': 'Password changed',
  'انتهت الجلسة، سجّل الدخول من جديد': 'Session expired, please sign in again',
  'تم تفعيل إشعارات هذا الجهاز': 'Notifications enabled on this device',
  'تم إيقاف إشعارات هذا الجهاز': 'Notifications disabled on this device',

  'التأخير (د)': 'Late (min)', 'وقت الحضور': 'Check-in', 'وقت الانصراف': 'Check-out',
  'ساعات العمل': 'Work hours', 'الملخص الشهري': 'Monthly summary', 'نسبة الحضور': 'Attendance %',
  'عرض الملخص الشهري': 'Show monthly summary', 'تقرير الاستثناءات (غياب / تأخير / انصراف ناقص)':
    'Exceptions report (absence / late / missing out)', 'إجراءات سريعة': 'Quick actions',
  'رصيد إجازة سنوية': 'Annual leave balance', 'فترة التجربة (٩٠ يوماً)': 'Probation (90 days)',
  'مدة العقد المتبقية': 'Contract time left', 'إجمالي المستحقات': 'Total earnings',
  'إجمالي الاستقطاعات': 'Total deductions', 'حسابك غير مرتبط بملف موظف — راجع الموارد البشرية.':
    'Your account is not linked to an employee file — contact HR.',

  'لوحة': 'Home', 'مثال: 2412345678': 'e.g. 2412345678', 'مثال: 0500000000': 'e.g. 0500000000',
  'name@example.com': 'name@example.com',
  'رقم جوالك هو اسم المستخدم عند الدخول.': 'Your mobile number is your username.',
  'حدّث بياناتك هنا وستصل الموارد البشرية مباشرة. الحقول الأخرى (الراتب، الوردية، تاريخ التعيين) تُعدّلها الموارد البشرية فقط.':
    'Update your details here and HR is notified. Other fields (salary, shift, hire date) are edited by HR only.',
  'للاستفسار عن الراتب أو الوردية راجع الموارد البشرية.':
    'For questions about salary or shift, please contact HR.',
  'دخلت بكلمة مرور مؤقتة (رقم جوالك). اختر كلمة مرور جديدة لتأمين حسابك — لن تتمكن من متابعة العمل قبل تغييرها.':
    'You signed in with a temporary password (your mobile number). Choose a new password — you cannot continue before changing it.',
  'لتشغيله كتطبيق مستقل وتصلك الإشعارات بنغمة: اضغط زر المشاركة في سفاري ثم «إضافة إلى الشاشة الرئيسية».':
    'To run it as an app and receive sound notifications: tap Share in Safari, then "Add to Home Screen".',
  'يصلك الإشعار بنغمة الجهاز حتى والتطبيق مغلق. على الآيفون: أضف النظام إلى الشاشة الرئيسية أولاً (مشاركة ← إضافة إلى الشاشة الرئيسية) ثم فعّل الإشعارات من هنا.':
    'Notifications arrive with your device sound even when the app is closed. On iPhone: add the system to your Home Screen first (Share → Add to Home Screen), then enable notifications here.',
  'حسابك غير مرتبط بملف موظف، لذلك لا يظهر لك رصيد إجازات ولا يمكنك تقديم طلب. راجع الموارد البشرية لربط الحساب باسمك في قائمة الموظفين.':
    'Your account is not linked to an employee file, so no leave balance is shown and you cannot request leave. Contact HR to link your account.',
  'أجهزتك المسجّلة:': 'Your registered devices:', 'إخفاء': 'Dismiss',
  'English / العربية': 'العربية / English',
  'يجب أن تكون داخل نطاق موقع العمل المعتمد عند التسجيل.':
    'You must be inside the approved work site when punching.',

  'أيام الراحة': 'Rest days', 'تقويم الراحة': 'Rest calendar', 'رصيد الشهر': 'Monthly quota',
  'المستخدم': 'Used', 'الرصيد': 'Quota', 'التواريخ': 'Dates', 'راحة': 'Rest',
  'يوم راحة مجدول': 'Scheduled rest day', 'ملخص الشهر لكل الموظفين': 'Monthly summary — all employees',
  'إجمالي أيام الراحة المجدولة': 'Scheduled rest days', 'لكل الموظفين هذا الشهر': 'All employees this month',
  'اضغط على أي يوم في التقويم لتحديده يوم راحة أو لإلغائه.':
    'Tap any day in the calendar to set or clear a rest day.',
  'تم تحديد يوم الراحة': 'Rest day set', 'أُلغي يوم الراحة': 'Rest day cleared',
  'لا توجد أيام راحة مجدولة هذا الشهر': 'No rest days scheduled this month',
  'تظهر هنا طلباتك أنت فقط.': 'Only your own requests appear here.',
  'الإقران مفتوح': 'Pairing open', 'الإقران مغلق': 'Pairing closed',
  'الإجازات والراحة الشهرية': 'Leaves & monthly rest',
  'أيام الراحة الشهرية لكل موظف': 'Monthly rest days per employee',
  'إظهار رصيد الإجازات للموظف': 'Show leave balance to employee',
  'مخفي': 'Hidden', 'ظاهر': 'Visible',

  'عرض الجدول الكامل': 'Open full table', 'الجدول الكامل': 'Full table',
  'الوضع الفاتح': 'Light mode', 'الوضع الداكن': 'Dark mode', 'تلقائي حسب الجهاز': 'Match device',
  'إصدار الواجهة': 'App version',
  'وصل تحديث جديد للتطبيق، جارٍ إعادة التحميل…': 'A new version arrived — reloading…',

  'الرئيسية': 'Home', 'جدولي': 'My schedule', 'الطلبات': 'Requests',
  'أنت الآن': 'You are now', 'داخل الدوام': 'On shift', 'خارج الدوام': 'Off shift',
  'أنهيت دوام اليوم': 'Shift completed', 'اليوم راحتك': 'Your day off',
  'تسجيل حضور': 'Check in', 'تسجيل انصراف': 'Check out', 'تسجيل حضور جديد': 'Check in again',
  'يتحقق من موقعك': 'Location verified', 'بلا تحقق موقع': 'No location check',
  'دوام اليوم': "Today's shift", 'آخر عملية حضور': 'Last punch',
  'الطلبات المعلّقة': 'Pending requests', 'جدول هذا الأسبوع': 'This week',
  'التفاصيل': 'Details', 'أسبوعي': 'My week', 'تم تسجيل حضور': 'Checked in',
  'تم تسجيل انصراف': 'Checked out', 'لم يُسجَّل بعد': 'Not recorded yet',
  'بدون موقع مسجّل': 'No site recorded', 'تأخير': 'Late', 'يُحتسب في المسير': 'Counted in payroll',

  // ------- الأيام والأشهر -------
  'الأحد': 'Sunday', 'الاثنين': 'Monday', 'الثلاثاء': 'Tuesday', 'الأربعاء': 'Wednesday',
  'الخميس': 'Thursday', 'الجمعة': 'Friday', 'السبت': 'Saturday',
  'يناير': 'January', 'فبراير': 'February', 'مارس': 'March', 'أبريل': 'April', 'مايو': 'May',
  'يونيو': 'June', 'يوليو': 'July', 'أغسطس': 'August', 'سبتمبر': 'September',
  'أكتوبر': 'October', 'نوفمبر': 'November', 'ديسمبر': 'December',
};

/* عبارات مركّبة بأرقام لا يمكن مطابقتها حرفياً */
const I18N_PATTERNS = [
  [/^رصيدي لعام (\d{4})$/, 'My balance for $1'],
  [/^تقويم (.+) (\d{4})$/, 'Calendar — $1 $2'],
  [/^([\d.]+) متبقٍ من ([\d.]+) يوم$/, '$1 of $2 days left'],
  [/^([\d.]+) متبقٍ من ([\d.]+) يوم — استُخدم ([\d.]+)$/, '$1 of $2 days left — $3 used'],
  [/^\((\d+) طلب\)$/, '($1 requests)'],
  [/^(\d+) طلب$/, '$1 requests'],
  [/^\((\d+) موظف\)$/, '($1 employees)'],
  [/^(\d+) موظف$/, '$1 employees'],
  [/^(\d+) سجل$/, '$1 records'],
  [/^(\d+) سلفة$/, '$1 loans'],
  [/^(\d+) يوم$/, '$1 days'],
  [/^(\d+) يوماً$/, '$1 days'],
  [/^من ([\d-]+)$/, 'From $1'],
  [/^إلى ([\d-]+)$/, 'To $1'],
  [/^مسير (\d+)$/, 'Run $1'],
  [/^خدمة: (.+)$/, 'Service: $1'],
  [/^خدمة (.+)$/, 'Service: $1'],
  [/^(\d+) سنة و(\d+) (?:شهر|شهران|أشهر|شهراً)$/, '$1 yr $2 mo'],
  [/^سنة و(\d+) (?:شهر|شهران|أشهر|شهراً)$/, '1 yr $1 mo'],
  [/^سنتان و(\d+) (?:شهر|شهران|أشهر|شهراً)$/, '2 yr $1 mo'],
  [/^(\d+) (?:شهر|أشهر|شهراً)$/, '$1 months'],
  [/^سنة$/, '1 year'], [/^سنتان$/, '2 years'], [/^(\d+) سنوات$/, '$1 years'],
  [/^شهر$/, '1 month'], [/^شهران$/, '2 months'], [/^أقل من شهر$/, 'Less than a month'],
  [/^من ([\d.]+) يوم عمل$/, 'of $1 working days'],
  [/^(\d+) موظف — (.+)$/, '$1 employees — $2'],
  [/^(\d+) فاتورة$/, '$1 invoices'],
  [/^(\d+) طلب$/, '$1 requests'],
  [/^تجاوز وقت الاستراحة بـ (\d+) دقيقة$/, 'Break overrun by $1 minutes'],
  [/^سُجّل تأخيرك اليوم (\d+) دقيقة$/, 'You were $1 minutes late today'],
  [/^بدأت دوامك (.+)$/, 'You started at $1'],
  [/^آخر انصراف (.+)$/, 'Last clock-out $1'],
  [/^مضى (\d+) من (\d+) يوماً — يتبقى (\d+) يوماً$/, '$1 of $2 days elapsed — $3 days left'],
  [/^([\d.,]+) ريال × (\d+) يوم$/, '$1 SAR × $2 days'],
];

const I18N = {
  lang: localStorage.getItem('hr_lang') || 'ar',
  dict: I18N_EN,
  patterns: I18N_PATTERNS,
  isEnglish() { return this.lang === 'en'; },
  /** ترجمة نص مفرد (يعيد الأصل إن لم توجد ترجمة) */
  t(text) {
    if (!this.isEnglish()) return text;
    const key = String(text || '').trim();
    return this.dict[key] || text;
  },
  /** ترجمة عبارة مركّبة بأرقام حسب الأنماط (تُترجم أسماء الأشهر داخلها أيضاً) */
  pattern(key) {
    for (const [regex, template] of this.patterns) {
      const match = key.match(regex);
      if (!match) continue;
      return template.replace(/\$(\d)/g, (_, index) => {
        const part = match[Number(index)] || '';
        return this.dict[part.trim()] || part;
      });
    }
    return null;
  },

  /** ترجمة كل النصوص المرسومة داخل عنصر */
  apply(root) {
    if (!this.isEnglish() || !root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentNode;
        if (!parent || ['SCRIPT', 'STYLE'].includes(parent.nodeName)) return NodeFilter.FILTER_REJECT;
        return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      const raw = node.nodeValue.trim();
      if (!raw) return;
      const key = raw.replace(/\s+/g, ' ');
      let value = this.dict[key];
      if (!value) {
        // نصوص تبدأ برمز أو أيقونة: «⚡ إجراءات سريعة» → نترجم الجزء النصي وحده
        const parts = key.match(/^([^\p{L}\p{N}]*)(.+?)([^\p{L}\p{N}]*)$/u);
        if (parts && this.dict[parts[2].trim()]) {
          value = parts[1] + this.dict[parts[2].trim()] + parts[3];
        }
      }
      if (!value) value = this.pattern(key);
      if (value) node.nodeValue = node.nodeValue.replace(raw, value);
    });
    root.querySelectorAll('[placeholder],[title],[aria-label]').forEach((element) => {
      ['placeholder', 'title', 'aria-label'].forEach((attr) => {
        const current = element.getAttribute(attr);
        if (!current) return;
        const value = this.dict[current.trim()];
        if (value) element.setAttribute(attr, value);
      });
    });
  },
  /** تبديل اللغة وإعادة رسم الواجهة */
  set(lang) {
    this.lang = lang === 'en' ? 'en' : 'ar';
    localStorage.setItem('hr_lang', this.lang);
    document.documentElement.lang = this.lang;
    document.documentElement.dir = this.lang === 'en' ? 'ltr' : 'rtl';
    location.reload();
  },
  init() {
    document.documentElement.lang = this.lang;
    document.documentElement.dir = this.lang === 'en' ? 'ltr' : 'rtl';
  },
};
I18N.init();
