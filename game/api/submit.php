<?php
/*
 * submit.php — استقبال نتيجة والتحقق من معقوليتها.
 *
 * ملاحظة صريحة: أي لعبة تعمل داخل المتصفح يمكن التلاعب بها نظرياً.
 * هذه الفحوصات ترفع تكلفة الغش كثيراً (توقيع + زمن + تكرار + حد IP)
 * لكنها لا تمنع مهاجماً مصمّماً بنسبة 100%.
 */
declare(strict_types=1);
require __DIR__ . '/lib.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail('POST required', 405);
}

$sid   = (string) ($_POST['sid'] ?? '');
$ts    = (int) ($_POST['ts'] ?? 0);
$sig   = (string) ($_POST['sig'] ?? '');
$score = (int) ($_POST['score'] ?? -1);
$coins = (int) ($_POST['coins'] ?? 0);
$name  = clean_name((string) ($_POST['name'] ?? ''));

if (!preg_match('/^[0-9a-f]{32}$/', $sid) || $ts <= 0 || $sig === '') {
    fail('bad ticket');
}
if (!hash_equals(hash_hmac('sha256', $sid . '|' . $ts, secret()), $sig)) {
    fail('bad signature', 403);
}

$now = time();
$age = $now - $ts;
$c   = cfg();

if ($age < (int) $c['min_round_seconds']) {
    fail('round too short');
}
if ($age > 7200) {
    fail('ticket expired');
}
if ($score < 0 || $score > 5000000) {
    fail('score out of range');
}
if ($score > $age * (int) $c['max_score_per_second'] + 300) {
    fail('score not plausible');
}
if ($coins < 0 || $coins > $age * 4 + 20) {
    fail('coins not plausible');
}
if (!rate_ok($now)) {
    fail('too many submissions, try later', 429);
}
if (!claim_round($sid, $now)) {
    fail('ticket already used', 409);
}

$rank = save_score($name, $score, $coins, $now);

json_out(['ok' => true, 'rank' => $rank, 'name' => $name, 'score' => $score]);
