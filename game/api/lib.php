<?php
/*
 * lib.php — أدوات مشتركة: الإعدادات، التخزين (MySQL أو JSON)، الأمان.
 */
declare(strict_types=1);

mb_internal_encoding('UTF-8');

const DATA_DIR = __DIR__ . '/../data';

function cfg(): array
{
    static $c = null;
    if ($c === null) {
        $c = require __DIR__ . '/config.php';
    }
    return $c;
}

function json_out(array $payload, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(string $msg, int $status = 400): void
{
    json_out(['ok' => false, 'error' => $msg], $status);
}

function data_dir(): string
{
    if (!is_dir(DATA_DIR)) {
        @mkdir(DATA_DIR, 0755, true);
    }
    return DATA_DIR;
}

/** مفتاح سري يُولَّد مرة واحدة ويُحفظ خارج الكود. */
function secret(): string
{
    static $s = null;
    if ($s !== null) {
        return $s;
    }
    $file = data_dir() . '/secret.key';
    $existing = @file_get_contents($file);
    if (is_string($existing) && strlen(trim($existing)) >= 32) {
        return $s = trim($existing);
    }
    $s = bin2hex(random_bytes(32));
    @file_put_contents($file, $s, LOCK_EX);
    return $s;
}

function client_ip(): string
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    return is_string($ip) ? substr($ip, 0, 45) : '';
}

/** اسم آمن للعرض: بلا وسوم ولا محارف تحكم، 20 حرفاً كحد أقصى. */
function clean_name(string $raw): string
{
    $n = strip_tags($raw);
    $n = preg_replace('/[\x00-\x1F\x7F]|[\p{Cf}]/u', '', $n) ?? '';
    $n = trim(preg_replace('/\s+/u', ' ', $n) ?? '');
    if ($n === '') {
        $n = 'لاعب';
    }
    return mb_substr($n, 0, 20);
}

/* ============ قاعدة البيانات (اختيارية) ============ */

function db(): ?PDO
{
    static $pdo = false;
    if ($pdo !== false) {
        return $pdo;
    }
    $c = cfg();
    if ($c['db_host'] === '' || $c['db_name'] === '' || $c['db_user'] === '') {
        return $pdo = null;
    }
    try {
        $dsn = "mysql:host={$c['db_host']};dbname={$c['db_name']};charset=utf8mb4";
        $pdo = new PDO($dsn, $c['db_user'], $c['db_pass'], [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
            PDO::ATTR_TIMEOUT            => 5,
        ]);
        $pdo->exec(
            'CREATE TABLE IF NOT EXISTS scores (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name_key VARCHAR(40) NOT NULL,
                name VARCHAR(40) NOT NULL,
                score INT UNSIGNED NOT NULL,
                coins INT UNSIGNED NOT NULL DEFAULT 0,
                ip VARCHAR(45) NOT NULL DEFAULT "",
                created_at INT UNSIGNED NOT NULL,
                UNIQUE KEY uniq_name (name_key),
                KEY idx_score (score)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
        );
        $pdo->exec(
            'CREATE TABLE IF NOT EXISTS rounds (
                sid CHAR(32) PRIMARY KEY,
                ip VARCHAR(45) NOT NULL DEFAULT "",
                created_at INT UNSIGNED NOT NULL,
                KEY idx_created (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
        );
    } catch (Throwable $e) {
        $pdo = null;
    }
    return $pdo;
}

/* ============ تخزين JSON احتياطي ============ */

function json_read(string $file): array
{
    $path = data_dir() . '/' . $file;
    if (!is_file($path)) {
        return [];
    }
    $raw = @file_get_contents($path);
    if (!is_string($raw) || $raw === '') {
        return [];
    }
    $d = json_decode($raw, true);
    return is_array($d) ? $d : [];
}

function json_write(string $file, array $data): bool
{
    $path = data_dir() . '/' . $file;
    $tmp  = $path . '.' . getmypid() . '.tmp';
    $ok = @file_put_contents($tmp, json_encode($data, JSON_UNESCAPED_UNICODE), LOCK_EX);
    if ($ok === false) {
        return false;
    }
    return @rename($tmp, $path);
}

/** يمنع إعادة استخدام نفس تذكرة الجولة. يرجع true إذا كانت جديدة. */
function claim_round(string $sid, int $now): bool
{
    if ($pdo = db()) {
        try {
            $pdo->prepare('INSERT INTO rounds (sid, ip, created_at) VALUES (?,?,?)')
                ->execute([$sid, client_ip(), $now]);
            if (random_int(1, 25) === 1) {
                $pdo->prepare('DELETE FROM rounds WHERE created_at < ?')->execute([$now - 86400]);
            }
            return true;
        } catch (Throwable $e) {
            return false; // مفتاح مكرر = محاولة إعادة إرسال
        }
    }
    $used = json_read('rounds.json');
    if (isset($used[$sid])) {
        return false;
    }
    foreach ($used as $k => $t) {
        if ($t < $now - 86400) {
            unset($used[$k]);
        }
    }
    $used[$sid] = $now;
    json_write('rounds.json', $used);
    return true;
}

/** حدّ الإرسال لكل IP في الساعة. */
function rate_ok(int $now): bool
{
    $limit = (int) cfg()['max_submits_per_hour'];
    $ip = client_ip();
    if ($ip === '') {
        return true;
    }
    $key = md5($ip);
    $all = json_read('rate.json');
    $hits = array_values(array_filter($all[$key] ?? [], static fn($t) => $t > $now - 3600));
    if (count($hits) >= $limit) {
        return false;
    }
    $hits[] = $now;
    $all[$key] = $hits;
    foreach ($all as $k => $v) {
        $v = array_filter($v, static fn($t) => $t > $now - 3600);
        if (!$v) {
            unset($all[$k]);
        } else {
            $all[$k] = array_values($v);
        }
    }
    json_write('rate.json', $all);
    return true;
}

/** يحفظ أفضل نتيجة لكل اسم ويعيد الترتيب. */
function save_score(string $name, int $score, int $coins, int $now): int
{
    $key = mb_strtolower($name);

    if ($pdo = db()) {
        $st = $pdo->prepare(
            'INSERT INTO scores (name_key, name, score, coins, ip, created_at)
             VALUES (?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE
                score = GREATEST(score, VALUES(score)),
                coins = GREATEST(coins, VALUES(coins)),
                created_at = VALUES(created_at)'
        );
        $st->execute([$key, $name, $score, $coins, client_ip(), $now]);
        $rk = $pdo->prepare('SELECT COUNT(*) + 1 FROM scores WHERE score > ?');
        $rk->execute([$score]);
        return (int) $rk->fetchColumn();
    }

    $rows = json_read('scores.json');
    $found = false;
    foreach ($rows as &$r) {
        if (($r['key'] ?? '') === $key) {
            $found = true;
            if ($score > (int) $r['score']) {
                $r['score'] = $score;
                $r['coins'] = $coins;
                $r['name']  = $name;
                $r['t']     = $now;
            }
            break;
        }
    }
    unset($r);
    if (!$found) {
        $rows[] = ['key' => $key, 'name' => $name, 'score' => $score, 'coins' => $coins, 't' => $now];
    }
    usort($rows, static fn($a, $b) => $b['score'] <=> $a['score']);
    $rows = array_slice($rows, 0, 500);
    json_write('scores.json', $rows);

    $rank = 1;
    foreach ($rows as $r) {
        if ((int) $r['score'] > $score) {
            $rank++;
        }
    }
    return $rank;
}

/** أفضل N نتيجة. */
function top_scores(int $limit = 20): array
{
    if ($pdo = db()) {
        $st = $pdo->prepare('SELECT name, score FROM scores ORDER BY score DESC, created_at ASC LIMIT ?');
        $st->bindValue(1, $limit, PDO::PARAM_INT);
        $st->execute();
        return array_map(
            static fn($r) => ['name' => (string) $r['name'], 'score' => (int) $r['score']],
            $st->fetchAll()
        );
    }
    $rows = array_slice(json_read('scores.json'), 0, $limit);
    return array_map(
        static fn($r) => ['name' => (string) ($r['name'] ?? 'لاعب'), 'score' => (int) ($r['score'] ?? 0)],
        $rows
    );
}
