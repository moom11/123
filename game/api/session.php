<?php
/*
 * session.php — يصدر "تذكرة جولة" موقّعة.
 * وقت الإصدار هو ما يثبت لاحقاً أن الجولة استغرقت وقتاً معقولاً.
 */
declare(strict_types=1);
require __DIR__ . '/lib.php';

$sid = bin2hex(random_bytes(16));
$ts  = time();
$sig = hash_hmac('sha256', $sid . '|' . $ts, secret());

json_out(['ok' => true, 'sid' => $sid, 'ts' => $ts, 'sig' => $sig]);
