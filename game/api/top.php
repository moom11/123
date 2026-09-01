<?php
/*
 * top.php — أفضل 20 نتيجة.
 */
declare(strict_types=1);
require __DIR__ . '/lib.php';

json_out(['ok' => true, 'rows' => top_scores(20)]);
