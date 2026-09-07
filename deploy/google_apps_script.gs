/**
 * ربط نظام الموارد البشرية بجوجل شيت — بدون حساب Google Cloud.
 *
 * الخطوات:
 *  1) أنشئ ملف Google Sheets جديداً.
 *  2) القائمة: الإضافات (Extensions) ← Apps Script.
 *  3) احذف الكود الموجود والصق هذا الملف كاملاً.
 *  4) غيّر قيمة SECRET أدناه إلى كلمة سر خاصة بك (ستضعها في النظام أيضاً).
 *  5) Deploy ← New deployment ← Type: Web app
 *       - Execute as: Me
 *       - Who has access: Anyone
 *     انسخ الرابط الناتج (ينتهي بـ /exec) وضعه في:
 *     الإعدادات ← ربط جوجل شيت ← رابط تطبيق الويب.
 *
 * ملاحظة أمان: الرابط يحتوي معرّفاً عشوائياً طويلاً، والسكربت يرفض أي طلب
 * لا يحمل كلمة السر الصحيحة، فلا يستطيع أحد الكتابة في ملفك بدونها.
 */

var SECRET = 'ضع-كلمة-سر-قوية-هنا';

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    if (!SECRET || data.secret !== SECRET) {
      return output({ ok: false, error: 'unauthorized' });
    }
    if (!data.rows || !data.rows.length) {
      return output({ ok: true, written: 0 });
    }

    var book = SpreadsheetApp.getActiveSpreadsheet();
    var name = data.sheet || data.dataset || 'البيانات';
    var sheet = book.getSheetByName(name);

    if (!sheet) {
      sheet = book.insertSheet(name);
      sheet.setRightToLeft(true);
    }

    // استبدال كامل عند إعادة المزامنة، أو إضافة في الحالة العادية
    if (data.mode === 'replace') {
      sheet.clear();
    }

    // كتابة صف العناوين مرة واحدة
    if (sheet.getLastRow() === 0 && data.headers && data.headers.length) {
      sheet.appendRow(data.headers);
      var header = sheet.getRange(1, 1, 1, data.headers.length);
      header.setFontWeight('bold').setBackground('#0f766e').setFontColor('#ffffff');
      sheet.setFrozenRows(1);
    }

    // كتابة كل الصفوف دفعة واحدة (أسرع بكثير من appendRow لكل صف)
    var width = data.headers ? data.headers.length : data.rows[0].length;
    var rows = data.rows.map(function (row) {
      var copy = row.slice(0, width);
      while (copy.length < width) copy.push('');
      return copy;
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, width).setValues(rows);
    sheet.autoResizeColumns(1, width);

    return output({ ok: true, written: rows.length, sheet: name });
  } catch (err) {
    return output({ ok: false, error: String(err) });
  }
}

function doGet() {
  return output({ ok: true, service: 'HR Sheets Bridge' });
}

function output(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
