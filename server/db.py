"""
Lavka Quality Shield — SQLite Database, Schema Migrations & Logging Module
"""

import json
import sqlite3
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any, Deque, Dict, List, Optional, Tuple

from matcher import is_search_result_matching_product, normalize_synonym_tokens, normalize_title_for_match
from security import DEFAULT_DB_PATH, migrate_legacy_db_if_needed

APP_VERSION = "2.10.0"
SCHEMA_VERSION = 5
DB_PATH = migrate_legacy_db_if_needed(__file__, DEFAULT_DB_PATH)
SERVER_LOGS: Deque[Dict[str, str]] = deque(maxlen=100)


def log_event(level: str, msg: str) -> None:
    now_str = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    SERVER_LOGS.appendleft({"ts": now_str, "level": level, "msg": msg})


class _ClosingConnection(sqlite3.Connection):
    """sqlite3.Connection subclass that commits/rolls back AND closes on context exit."""

    def __exit__(self, exc_type, exc_val, exc_tb):
        try:
            return super().__exit__(exc_type, exc_val, exc_tb)
        finally:
            self.close()


def get_db_connection(db_path: Optional[str] = None) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path or DB_PATH, timeout=5.0, factory=_ClosingConnection)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, col_type: str) -> None:
    cols = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")


def init_db(db_path: Optional[str] = None) -> None:
    global DB_PATH
    if db_path:
        DB_PATH = db_path
    with get_db_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS product_ai_cache (
                slug TEXT PRIMARY KEY,
                title TEXT,
                norm_title TEXT,
                verdict TEXT,
                sources_json TEXT,
                updated_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS price_observations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                slug TEXT,
                title TEXT,
                account_id TEXT,
                price REAL,
                old_price REAL,
                amount TEXT,
                observed_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS product_price_summary (
                slug TEXT PRIMARY KEY,
                title TEXT,
                norm_title TEXT,
                amount TEXT,
                min_price REAL,
                max_price REAL,
                avg_price REAL,
                last_price REAL,
                guest_price REAL,
                competitor_min_price REAL,
                competitor_summary TEXT,
                competitor_offers_json TEXT,
                accounts_json TEXT,
                history_json TEXT,
                updated_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS price_watchlist (
                slug TEXT PRIMARY KEY,
                title TEXT,
                norm_title TEXT,
                amount TEXT,
                target_price REAL,
                last_price REAL,
                baseline_price REAL,
                last_checked_at TEXT,
                created_at TEXT,
                updated_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS saved_carts (
                cart_id TEXT PRIMARY KEY,
                account_id TEXT,
                items_json TEXT,
                total_price REAL,
                updated_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS saved_accounts (
                account_id TEXT PRIMARY KEY,
                label TEXT,
                login TEXT,
                password TEXT,
                note TEXT,
                yandex_login TEXT,
                cookie_count INTEGER,
                cookies_json TEXT,
                local_storage_json TEXT,
                updated_at TEXT
            )
            """
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ai_provider_keys (
                provider TEXT PRIMARY KEY,
                encrypted_key TEXT,
                key_mask TEXT,
                updated_at TEXT
            )
            """
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS product_store_links (
                slug TEXT NOT NULL,
                store_id TEXT NOT NULL,
                store_name TEXT,
                product_url TEXT NOT NULL,
                product_title TEXT,
                source_retailer TEXT,
                last_price REAL,
                last_checked_at TEXT,
                updated_at TEXT,
                PRIMARY KEY (slug, store_id)
            )
            """
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS external_store_offers (
                offer_key TEXT PRIMARY KEY,
                store_id TEXT NOT NULL,
                store TEXT NOT NULL,
                source_retailer TEXT,
                good_id TEXT,
                title TEXT NOT NULL,
                norm_title TEXT NOT NULL,
                brand TEXT,
                amount TEXT,
                price REAL NOT NULL,
                old_price REAL,
                url TEXT,
                updated_at TEXT
            )
            """
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS external_price_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                offer_key TEXT NOT NULL,
                store_id TEXT NOT NULL,
                store TEXT NOT NULL,
                title TEXT NOT NULL,
                norm_title TEXT NOT NULL,
                url TEXT,
                price REAL NOT NULL,
                old_price REAL,
                observed_day TEXT NOT NULL,
                observed_at TEXT NOT NULL,
                UNIQUE (offer_key, observed_day)
            )
            """
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS rejected_product_matches (
                source_key TEXT NOT NULL,
                rejected_url_or_title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (source_key, rejected_url_or_title)
            )
            """
        )

        # Schema migrations via PRAGMA user_version
        current_version = int(conn.execute("PRAGMA user_version").fetchone()[0] or 0)
        if current_version < 1:
            _ensure_column(conn, "product_price_summary", "competitor_offers_json", "TEXT")
            conn.execute("PRAGMA user_version = 1")
            current_version = 1

        if current_version < 2:
            _ensure_column(conn, "product_ai_cache", "norm_title", "TEXT")
            _ensure_column(conn, "product_price_summary", "norm_title", "TEXT")

            # Backfill norm_title for existing rows
            for table in ("product_ai_cache", "product_price_summary"):
                rows = conn.execute(
                    f"SELECT slug, title FROM {table} WHERE norm_title IS NULL OR norm_title = ''"
                ).fetchall()
                for slug_val, title_val in rows:
                    nt = normalize_title_for_match(title_val or "")
                    conn.execute(f"UPDATE {table} SET norm_title = ? WHERE slug = ?", (nt, slug_val))

            conn.execute("PRAGMA user_version = 2")
            current_version = 2

        if current_version < 3:
            # v2.9.0: очищаем устаревшие маркетинговые цены «Гость (без куки)» из сводок
            conn.execute("UPDATE product_price_summary SET guest_price = NULL WHERE guest_price IS NOT NULL")
            summary_rows = conn.execute("SELECT slug, accounts_json FROM product_price_summary").fetchall()
            for slug_val, acc_raw in summary_rows:
                try:
                    acc_map = json.loads(acc_raw or "{}")
                except Exception:
                    continue
                if isinstance(acc_map, dict) and "Гость (без куки)" in acc_map:
                    acc_map.pop("Гость (без куки)", None)
                    conn.execute(
                        "UPDATE product_price_summary SET accounts_json = ? WHERE slug = ?",
                        (json.dumps(acc_map, ensure_ascii=False), slug_val),
                    )
            conn.execute("PRAGMA user_version = 3")
            current_version = 3

        if current_version < 4:
            conn.execute("PRAGMA user_version = 4")
            current_version = 4

        if current_version < 5:
            conn.execute("PRAGMA user_version = 5")
            current_version = 5

        # Indexes for fast cache, price & watchlist lookups
        conn.execute("CREATE INDEX IF NOT EXISTS idx_price_obs_slug ON price_observations(slug)")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_price_obs_slug_observed ON price_observations(slug, observed_at DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ai_cache_norm_title ON product_ai_cache(norm_title, updated_at DESC)"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_ai_cache_updated_at ON product_ai_cache(updated_at DESC)")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_price_summary_norm_title ON product_price_summary(norm_title, updated_at DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_price_summary_updated_at ON product_price_summary(updated_at DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_price_watchlist_updated ON price_watchlist(updated_at DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_product_store_links_slug ON product_store_links(slug, updated_at DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ext_offers_store_norm ON external_store_offers(store_id, norm_title)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ext_offers_norm_title ON external_store_offers(norm_title, updated_at DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ext_offers_url ON external_store_offers(url)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ext_offers_updated_at ON external_store_offers(updated_at DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ext_price_history_key_day ON external_price_history(offer_key, observed_day ASC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ext_price_history_url ON external_price_history(url, observed_at ASC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_rejected_matches_source ON rejected_product_matches(source_key)"
        )

        conn.execute("DELETE FROM product_ai_cache WHERE verdict LIKE '⚠️ Ошибка вызова ИИ%'")
        conn.commit()
    log_event("INIT", f"SQLite v{APP_VERSION} (schema v{SCHEMA_VERSION}, WAL) initialized")


def find_existing_summary_row_by_slug_or_title(
    conn: sqlite3.Connection, clean_slug: str, title: Optional[str] = None
) -> Optional[Tuple[Any, ...]]:
    row = conn.execute(
        """
        SELECT slug, title, amount, min_price, max_price, avg_price, last_price, guest_price,
               competitor_min_price, competitor_summary, competitor_offers_json, accounts_json, history_json, updated_at
        FROM product_price_summary WHERE slug = ?
        """,
        (clean_slug,),
    ).fetchone()
    if row:
        return row
    norm_title = normalize_title_for_match(title)
    if norm_title and len(norm_title) >= 5:
        rows = conn.execute(
            """
            SELECT slug, title, amount, min_price, max_price, avg_price, last_price, guest_price,
                   competitor_min_price, competitor_summary, competitor_offers_json, accounts_json, history_json, updated_at
            FROM product_price_summary
            WHERE norm_title = ? OR LOWER(title) = ?
            ORDER BY updated_at DESC LIMIT 1
            """,
            (norm_title, norm_title),
        ).fetchone()
        if rows:
            return rows
    return None


def find_watchlist_row_by_slug_or_title(
    conn: sqlite3.Connection, clean_slug: str, title: Optional[str] = None
) -> Optional[Tuple[Any, ...]]:
    row = conn.execute(
        """
        SELECT slug, title, norm_title, amount, target_price, last_price, baseline_price,
               last_checked_at, created_at, updated_at
        FROM price_watchlist WHERE slug = ?
        """,
        (clean_slug,),
    ).fetchone()
    if row:
        return row
    norm_title = normalize_title_for_match(title)
    if norm_title and len(norm_title) >= 5:
        row = conn.execute(
            """
            SELECT slug, title, norm_title, amount, target_price, last_price, baseline_price,
                   last_checked_at, created_at, updated_at
            FROM price_watchlist
            WHERE norm_title = ? OR LOWER(title) = ?
            ORDER BY updated_at DESC LIMIT 1
            """,
            (norm_title, norm_title),
        ).fetchone()
        if row:
            return row
    return None


def upsert_price_observation_sync(
    conn: sqlite3.Connection,
    slug: str,
    title: str,
    account_id: str,
    price: float,
    old_price: Optional[float] = None,
    amount: Optional[str] = "",
    competitor_min: Optional[float] = None,
    competitor_summary: Optional[str] = None,
    competitor_offers: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    clean_slug = slug.strip().lower()
    now_iso = datetime.now(timezone.utc).isoformat()
    acc = (account_id or "Аккаунт #1").strip()

    row = find_existing_summary_row_by_slug_or_title(conn, clean_slug, title)
    canonical_slug = row[0] if row else clean_slug

    if price and price > 0:
        conn.execute(
            """
            INSERT INTO price_observations (slug, title, account_id, price, old_price, amount, observed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (canonical_slug, title or canonical_slug, acc, float(price), old_price, amount or "", now_iso),
        )

    if row:
        cur_title = title or row[1] or canonical_slug
        cur_amount = amount or row[2] or ""
        cur_comp_min = competitor_min if (competitor_min and competitor_min > 0) else row[8]
        cur_comp_sum = competitor_summary if competitor_summary else row[9]
        try:
            existing_offers = json.loads(row[10] or "[]")
        except Exception:
            existing_offers = []
        cur_comp_offers = competitor_offers if (competitor_offers and len(competitor_offers) > 0) else existing_offers
        try:
            accounts_map = json.loads(row[11] or "{}")
        except Exception:
            accounts_map = {}
        try:
            history_list = json.loads(row[12] or "[]")
        except Exception:
            history_list = []
    else:
        cur_title = title or canonical_slug
        cur_amount = amount or ""
        cur_comp_min = competitor_min if (competitor_min and competitor_min > 0) else None
        cur_comp_sum = competitor_summary or None
        cur_comp_offers = competitor_offers or []
        accounts_map = {}
        history_list = []

    # Никогда не храним устаревшую маркетинговую цену «Гость (без куки)»
    accounts_map.pop("Гость (без куки)", None)

    if price and price > 0:
        rounded_price = round(float(price), 2)
        rounded_old = round(float(old_price), 2) if old_price else None
        accounts_map[acc] = {
            "price": rounded_price,
            "oldPrice": rounded_old,
            "updatedAt": now_iso,
        }
        now_day = now_iso[:10]
        last_entry = history_list[0] if history_list else None
        last_day = str(last_entry.get("ts") or "")[:10] if last_entry else ""
        should_append = (
            not last_entry
            or last_entry.get("price") != rounded_price
            or last_entry.get("accountId") != acc
            or last_day != now_day
        )
        if should_append:
            history_list.insert(
                0,
                {
                    "price": rounded_price,
                    "oldPrice": rounded_old,
                    "accountId": acc,
                    "ts": now_iso,
                },
            )
            history_list = history_list[:120]

    all_prices = [float(h["price"]) for h in history_list if h.get("price") and float(h["price"]) > 0]
    if not all_prices:
        for a_val in accounts_map.values():
            if isinstance(a_val, dict) and a_val.get("price") and float(a_val["price"]) > 0:
                all_prices.append(float(a_val["price"]))
        if not all_prices and price and price > 0:
            all_prices.append(float(price))

    if all_prices:
        min_p = round(min(all_prices), 2)
        max_p = round(max(all_prices), 2)
        avg_p = round(sum(all_prices) / len(all_prices), 2)
        last_p = round(float(price), 2) if (price and price > 0) else round(all_prices[0], 2)
    else:
        min_p = max_p = avg_p = last_p = 0.0

    conn.execute(
        """
        INSERT OR REPLACE INTO product_price_summary (
            slug, title, norm_title, amount, min_price, max_price, avg_price, last_price,
            guest_price, competitor_min_price, competitor_summary, competitor_offers_json,
            accounts_json, history_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            canonical_slug,
            cur_title,
            normalize_title_for_match(cur_title),
            cur_amount,
            min_p,
            max_p,
            avg_p,
            last_p,
            None,
            cur_comp_min,
            cur_comp_sum,
            json.dumps(cur_comp_offers, ensure_ascii=False),
            json.dumps(accounts_map, ensure_ascii=False),
            json.dumps(history_list, ensure_ascii=False),
            now_iso,
        ),
    )

    # Если товар в списке отслеживания — синхронизируем его последнюю цену и время проверки
    w_row = find_watchlist_row_by_slug_or_title(conn, canonical_slug, cur_title)
    if w_row and price and price > 0:
        conn.execute(
            """
            UPDATE price_watchlist
            SET last_price = ?, last_checked_at = ?, updated_at = ?
            WHERE slug = ?
            """,
            (round(float(price), 2), now_iso, now_iso, w_row[0]),
        )

    return {
        "slug": canonical_slug,
        "title": cur_title,
        "amount": cur_amount,
        "minPrice": min_p,
        "maxPrice": max_p,
        "avgPrice": avg_p,
        "lastPrice": last_p,
        "competitorMinPrice": cur_comp_min,
        "competitorSummary": cur_comp_sum,
        "competitorOffers": cur_comp_offers,
        "accounts": accounts_map,
        "history": history_list,
        "isWatched": bool(w_row),
        "targetPrice": w_row[4] if w_row else None,
        "updatedAt": now_iso,
    }


def get_price_history_series(
    conn: sqlite3.Connection,
    slug: str,
    title: Optional[str] = None,
    days: int = 90,
    account_id: Optional[str] = None,
    limit: int = 1000,
) -> Dict[str, Any]:
    clean_slug = slug.strip().lower()
    summary_row = find_existing_summary_row_by_slug_or_title(conn, clean_slug, title)
    canonical_slug = summary_row[0] if summary_row else clean_slug
    resolved_title = (summary_row[1] if summary_row else None) or title or canonical_slug
    resolved_amount = summary_row[2] if summary_row else ""

    cutoff_iso: Optional[str] = None
    if days and days > 0:
        cutoff_iso = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()

    slugs_to_query = [canonical_slug]
    if clean_slug != canonical_slug:
        slugs_to_query.append(clean_slug)

    placeholders = ",".join("?" for _ in slugs_to_query)
    params: List[Any] = list(slugs_to_query)
    where_clauses = [f"slug IN ({placeholders})", "price > 0"]
    if cutoff_iso:
        where_clauses.append("observed_at >= ?")
        params.append(cutoff_iso)
    if account_id:
        where_clauses.append("account_id = ?")
        params.append(account_id.strip())
    params.append(limit)

    obs_rows = conn.execute(
        f"""
        SELECT price, old_price, account_id, observed_at
        FROM price_observations
        WHERE {' AND '.join(where_clauses)}
        ORDER BY observed_at ASC
        LIMIT ?
        """,
        tuple(params),
    ).fetchall()

    # Fallback к history_json, если в legacy БД price_observations пуста
    points: List[Dict[str, Any]] = []
    if obs_rows:
        for r in obs_rows:
            acc_val = r[2] or "Аккаунт #1"
            if acc_val == "Гость (без куки)":
                continue
            points.append(
                {
                    "price": round(float(r[0]), 2),
                    "oldPrice": round(float(r[1]), 2) if r[1] else None,
                    "accountId": acc_val,
                    "ts": r[3],
                }
            )
    elif summary_row:
        try:
            hist = json.loads(summary_row[12] or "[]")
        except Exception:
            hist = []
        for h in reversed(hist):
            if not isinstance(h, dict) or not h.get("price"):
                continue
            ts_val = str(h.get("ts") or "")
            acc_val = str(h.get("accountId") or "Аккаунт #1")
            if acc_val == "Гость (без куки)":
                continue
            if cutoff_iso and ts_val and ts_val < cutoff_iso:
                continue
            if account_id and acc_val != account_id.strip():
                continue
            points.append(
                {
                    "price": round(float(h["price"]), 2),
                    "oldPrice": round(float(h["oldPrice"]), 2) if h.get("oldPrice") else None,
                    "accountId": acc_val,
                    "ts": ts_val,
                }
            )

    # Агрегация «Средняя» по дням (YYYY-MM-DD)
    daily_buckets: Dict[str, List[float]] = {}
    accounts_seen: List[str] = []
    for pt in points:
        day_key = str(pt.get("ts") or "")[:10]
        if day_key:
            daily_buckets.setdefault(day_key, []).append(float(pt["price"]))
        acc_val = pt.get("accountId")
        if acc_val and acc_val not in accounts_seen:
            accounts_seen.append(acc_val)

    daily_avg: List[Dict[str, Any]] = []
    for day_key in sorted(daily_buckets.keys()):
        vals = daily_buckets[day_key]
        daily_avg.append(
            {
                "date": day_key,
                "ts": f"{day_key}T12:00:00+00:00",
                "price": round(sum(vals) / len(vals), 2),
                "minPrice": round(min(vals), 2),
                "maxPrice": round(max(vals), 2),
                "count": len(vals),
            }
        )

    all_prices = [p["price"] for p in points if p.get("price") and p["price"] > 0]
    if all_prices:
        stats = {
            "minPrice": round(min(all_prices), 2),
            "maxPrice": round(max(all_prices), 2),
            "avgPrice": round(sum(all_prices) / len(all_prices), 2),
            "lastPrice": round(all_prices[-1], 2),
            "count": len(all_prices),
        }
    else:
        stats = {
            "minPrice": summary_row[3] if summary_row else None,
            "maxPrice": summary_row[4] if summary_row else None,
            "avgPrice": summary_row[5] if summary_row else None,
            "lastPrice": summary_row[6] if summary_row else None,
            "count": 0,
        }

    w_row = find_watchlist_row_by_slug_or_title(conn, canonical_slug, resolved_title)

    return {
        "slug": canonical_slug,
        "title": resolved_title,
        "amount": resolved_amount,
        "days": days,
        "points": points,
        "dailyAvg": daily_avg,
        "stats": stats,
        "accounts": accounts_seen,
        "isWatched": bool(w_row),
        "targetPrice": w_row[4] if w_row else None,
    }


def upsert_watchlist_item(
    conn: sqlite3.Connection,
    slug: str,
    title: str = "",
    amount: str = "",
    current_price: Optional[float] = None,
    target_price: Optional[float] = None,
) -> Dict[str, Any]:
    clean_slug = slug.strip().lower()
    now_iso = datetime.now(timezone.utc).isoformat()
    summary_row = find_existing_summary_row_by_slug_or_title(conn, clean_slug, title)
    canonical_slug = summary_row[0] if summary_row else clean_slug
    existing = find_watchlist_row_by_slug_or_title(conn, canonical_slug, title)

    final_title = title or (existing[1] if existing else None) or (summary_row[1] if summary_row else canonical_slug)
    final_amount = amount or (existing[3] if existing else None) or (summary_row[2] if summary_row else "")
    eff_price = (
        round(float(current_price), 2)
        if (current_price and current_price > 0)
        else (existing[5] if existing and existing[5] else (summary_row[6] if summary_row else None))
    )
    baseline = existing[6] if (existing and existing[6]) else eff_price
    eff_target = (
        round(float(target_price), 2)
        if (target_price is not None and target_price > 0)
        else (existing[4] if existing else None)
    )
    created_at = existing[8] if existing else now_iso

    conn.execute(
        """
        INSERT OR REPLACE INTO price_watchlist (
            slug, title, norm_title, amount, target_price, last_price, baseline_price,
            last_checked_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            canonical_slug,
            final_title,
            normalize_title_for_match(final_title),
            final_amount,
            eff_target,
            eff_price,
            baseline,
            now_iso if eff_price else (existing[7] if existing else None),
            created_at,
            now_iso,
        ),
    )

    return {
        "slug": canonical_slug,
        "title": final_title,
        "amount": final_amount,
        "targetPrice": eff_target,
        "lastPrice": eff_price,
        "baselinePrice": baseline,
        "lastCheckedAt": now_iso if eff_price else (existing[7] if existing else None),
        "createdAt": created_at,
        "updatedAt": now_iso,
    }


def delete_watchlist_item(conn: sqlite3.Connection, slug: str, title: Optional[str] = None) -> bool:
    clean_slug = slug.strip().lower()
    existing = find_watchlist_row_by_slug_or_title(conn, clean_slug, title)
    target_slug = existing[0] if existing else clean_slug
    cur = conn.execute("DELETE FROM price_watchlist WHERE slug = ?", (target_slug,))
    return cur.rowcount > 0


def list_watchlist_items(conn: sqlite3.Connection, limit: int = 200) -> List[Dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT w.slug, w.title, w.amount, w.target_price, w.last_price, w.baseline_price,
               w.last_checked_at, w.created_at, w.updated_at,
               s.min_price, s.max_price, s.avg_price, s.last_price
        FROM price_watchlist w
        LEFT JOIN product_price_summary s ON s.slug = w.slug
        ORDER BY w.updated_at DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    items: List[Dict[str, Any]] = []
    for r in rows:
        last_p = r[12] if r[12] is not None else r[4]
        baseline_p = r[5]
        price_diff = round(last_p - baseline_p, 2) if (last_p is not None and baseline_p is not None) else 0.0
        items.append(
            {
                "slug": r[0],
                "title": r[1],
                "amount": r[2],
                "targetPrice": r[3],
                "lastPrice": last_p,
                "baselinePrice": baseline_p,
                "priceDiff": price_diff,
                "minPrice": r[9],
                "maxPrice": r[10],
                "avgPrice": r[11],
                "lastCheckedAt": r[6],
                "createdAt": r[7],
                "updatedAt": r[8],
            }
        )
    return items


def upsert_ai_provider_key(
    conn: sqlite3.Connection,
    provider: str,
    encrypted_key: str,
    key_mask: str,
    updated_at: Optional[str] = None,
) -> Dict[str, Any]:
    clean_provider = (provider or "").strip().lower()
    now_iso = updated_at or datetime.now(timezone.utc).isoformat()
    conn.execute(
        """
        INSERT OR REPLACE INTO ai_provider_keys (provider, encrypted_key, key_mask, updated_at)
        VALUES (?, ?, ?, ?)
        """,
        (clean_provider, encrypted_key, key_mask, now_iso),
    )
    return {
        "provider": clean_provider,
        "hasKey": bool(encrypted_key),
        "mask": key_mask,
        "updatedAt": now_iso,
    }


def get_ai_provider_key_row(conn: sqlite3.Connection, provider: str) -> Optional[Tuple[str, str, str]]:
    clean_provider = (provider or "").strip().lower()
    if not clean_provider:
        return None
    row = conn.execute(
        "SELECT encrypted_key, key_mask, updated_at FROM ai_provider_keys WHERE provider = ?",
        (clean_provider,),
    ).fetchone()
    return row if row else None


def list_ai_provider_keys_status(conn: sqlite3.Connection) -> Dict[str, Dict[str, Any]]:
    rows = conn.execute(
        "SELECT provider, key_mask, updated_at FROM ai_provider_keys ORDER BY updated_at DESC"
    ).fetchall()
    result: Dict[str, Dict[str, Any]] = {}
    for prov, mask, upd in rows:
        result[prov] = {
            "provider": prov,
            "hasKey": True,
            "mask": mask or "",
            "updatedAt": upd,
        }
    return result


def delete_ai_provider_key(conn: sqlite3.Connection, provider: str) -> bool:
    clean_provider = (provider or "").strip().lower()
    cur = conn.execute("DELETE FROM ai_provider_keys WHERE provider = ?", (clean_provider,))
    return cur.rowcount > 0


def get_product_store_links(conn: sqlite3.Connection, slug: str) -> Dict[str, Dict[str, Any]]:
    clean_slug = str(slug or "").strip().lower()
    if not clean_slug:
        return {}
    rows = conn.execute(
        """
        SELECT store_id, store_name, product_url, product_title, source_retailer,
               last_price, last_checked_at, updated_at
        FROM product_store_links
        WHERE slug = ?
        ORDER BY updated_at DESC
        """,
        (clean_slug,),
    ).fetchall()
    result: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        result[r[0]] = {
            "storeId": r[0],
            "storeName": r[1] or r[0],
            "url": r[2],
            "title": r[3] or "",
            "sourceRetailer": r[4] or None,
            "lastPrice": r[5],
            "lastCheckedAt": r[6],
            "updatedAt": r[7],
        }
    return result


def upsert_product_store_links(
    conn: sqlite3.Connection, slug: str, links: List[Dict[str, Any]]
) -> int:
    clean_slug = str(slug or "").strip().lower()
    if not clean_slug or not links:
        return 0
    now_iso = datetime.now(timezone.utc).isoformat()
    saved = 0
    for item in links[:16]:
        if not isinstance(item, dict):
            continue
        store_id = str(item.get("storeId") or "").strip().lower()
        url = str(item.get("url") or "").strip()
        if not store_id or not (url.startswith("https://") or url.startswith("http://")):
            continue
        store_name = str(item.get("storeName") or store_id).strip()[:80]
        title = str(item.get("title") or "").strip()[:240]
        source_retailer = str(item.get("sourceRetailer") or "").strip()[:80] or None
        raw_price = item.get("lastPrice")
        last_price = float(raw_price) if isinstance(raw_price, (int, float)) and raw_price > 0 else None
        last_checked = str(item.get("lastCheckedAt") or now_iso)
        conn.execute(
            """
            INSERT INTO product_store_links (
                slug, store_id, store_name, product_url, product_title,
                source_retailer, last_price, last_checked_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(slug, store_id) DO UPDATE SET
                store_name = excluded.store_name,
                product_url = excluded.product_url,
                product_title = excluded.product_title,
                source_retailer = excluded.source_retailer,
                last_price = COALESCE(excluded.last_price, product_store_links.last_price),
                last_checked_at = excluded.last_checked_at,
                updated_at = excluded.updated_at
            """,
            (
                clean_slug,
                store_id,
                store_name,
                url[:1000],
                title,
                source_retailer,
                last_price,
                last_checked,
                now_iso,
            ),
        )
        saved += 1
    return saved


def delete_product_store_link(conn: sqlite3.Connection, slug: str, store_id: str) -> bool:
    clean_slug = str(slug or "").strip().lower()
    clean_store = str(store_id or "").strip().lower()
    if not clean_slug or not clean_store:
        return False
    cur = conn.execute(
        "DELETE FROM product_store_links WHERE slug = ? AND store_id = ?",
        (clean_slug, clean_store),
    )
    return cur.rowcount > 0
_STORE_ID_PATTERNS = (
    ("magnit", ("магнит", "magnit")),
    ("pyaterochka", ("пятёрочк", "пятерочк", "5ka", "pyaterochka")),
    ("perekrestok", ("перекрёсток", "перекресток", "perekrestok", "впрок", "vprok")),
    ("vkusvill", ("вкусвилл", "vkusvill")),
    ("auchan", ("ашан", "auchan")),
    ("lenta", ("лента", "lenta")),
    ("kuper", ("купер", "kuper", "сбермаркет", "sbermarket")),
    ("lavka", ("лавка", "lavka")),
)


def normalize_store_id(store_name: str = "", url: str = "") -> str:
    combined = f"{store_name or ''} {url or ''}".strip().lower().replace("ё", "е")
    for canonical, tokens in _STORE_ID_PATTERNS:
        if any(tok in combined for tok in tokens):
            return canonical
    clean = normalize_title_for_match(store_name)
    return clean[:40] if clean else "unknown"


def _clean_offer_url(url: Optional[str]) -> str:
    raw = str(url or "").strip()
    if not (raw.startswith("http://") or raw.startswith("https://")):
        return ""
    return raw.split("#", 1)[0][:1000]


def make_external_offer_key(store_id: str, url: str, norm_title: str) -> str:
    clean_url = _clean_offer_url(url)
    lower_url = clean_url.lower()
    is_search_fallback = bool(
        clean_url and any(seg in lower_url for seg in ("/search?", "/multisearch?", "?term=", "?q="))
    )
    if clean_url and not is_search_fallback:
        return f"{store_id}|{clean_url}"
    return f"{store_id}|title:{norm_title[:240]}"


def count_external_store_offers(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT COUNT(*) FROM external_store_offers").fetchone()
    return int(row[0] or 0) if row else 0


def upsert_external_store_offers_batch(
    conn: sqlite3.Connection,
    offers: List[Dict[str, Any]],
    default_store: str = "",
) -> Dict[str, int]:
    now_iso = datetime.now(timezone.utc).isoformat()
    today_day = now_iso[:10]
    saved = 0

    for raw in offers or []:
        if not isinstance(raw, dict):
            continue
        title = str(raw.get("title") or "").strip()[:260]
        raw_price = raw.get("price")
        try:
            price = round(float(raw_price), 2)
        except (TypeError, ValueError):
            continue
        if not title or len(title) < 2 or price <= 0:
            continue

        store = str(raw.get("store") or default_store or "Магнит").strip()[:80]
        url = _clean_offer_url(raw.get("url"))
        store_id = normalize_store_id(store, url)
        norm_title = normalize_title_for_match(title)
        if not norm_title:
            continue

        offer_key = make_external_offer_key(store_id, url, norm_title)
        source_retailer = str(raw.get("sourceRetailer") or raw.get("source_retailer") or "").strip()[:80] or None
        good_id = str(raw.get("goodId") or raw.get("good_id") or "").strip()[:120] or None
        brand = str(raw.get("brand") or "").strip()[:120]
        amount = str(raw.get("amount") or "").strip()[:80]
        raw_old = raw.get("oldPrice") if "oldPrice" in raw else raw.get("old_price")
        try:
            old_price = round(float(raw_old), 2) if raw_old is not None and float(raw_old) > 0 else None
        except (TypeError, ValueError):
            old_price = None

        conn.execute(
            """
            INSERT INTO external_store_offers (
                offer_key, store_id, store, source_retailer, good_id,
                title, norm_title, brand, amount, price, old_price, url, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(offer_key) DO UPDATE SET
                store = excluded.store,
                source_retailer = COALESCE(excluded.source_retailer, external_store_offers.source_retailer),
                good_id = COALESCE(excluded.good_id, external_store_offers.good_id),
                title = excluded.title,
                norm_title = excluded.norm_title,
                brand = CASE WHEN excluded.brand != '' THEN excluded.brand ELSE external_store_offers.brand END,
                amount = CASE WHEN excluded.amount != '' THEN excluded.amount ELSE external_store_offers.amount END,
                price = excluded.price,
                old_price = excluded.old_price,
                url = CASE WHEN excluded.url != '' THEN excluded.url ELSE external_store_offers.url END,
                updated_at = excluded.updated_at
            """,
            (
                offer_key,
                store_id,
                store,
                source_retailer,
                good_id,
                title,
                norm_title,
                brand,
                amount,
                price,
                old_price,
                url,
                now_iso,
            ),
        )

        conn.execute(
            """
            INSERT INTO external_price_history (
                offer_key, store_id, store, title, norm_title, url,
                price, old_price, observed_day, observed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(offer_key, observed_day) DO UPDATE SET
                price = excluded.price,
                old_price = excluded.old_price,
                title = excluded.title,
                url = CASE WHEN excluded.url != '' THEN excluded.url ELSE external_price_history.url END,
                observed_at = excluded.observed_at
            """,
            (
                offer_key,
                store_id,
                store,
                title,
                norm_title,
                url,
                price,
                old_price,
                today_day,
                now_iso,
            ),
        )
        saved += 1

    total = count_external_store_offers(conn)
    return {"savedCount": saved, "totalInSqlite": total}


def find_matching_external_store_offers(
    conn: sqlite3.Connection,
    title: str,
    brand: str = "",
    amount: str = "",
    exclude_store: str = "",
    target_price: Optional[float] = None,
    limit: int = 50,
) -> List[Dict[str, Any]]:
    clean_title = str(title or "").strip()
    if len(clean_title) < 2:
        return []

    full_target_title = clean_title
    if brand and brand.strip().lower() not in clean_title.lower():
        full_target_title = f"{clean_title} {brand.strip()}"

    exclude_id = normalize_store_id(exclude_store) if exclude_store and exclude_store.strip() else ""
    exclude_lower = (exclude_store or "").strip().lower()

    total_rows = count_external_store_offers(conn)
    if total_rows == 0:
        return []

    # Fast SQL prefilter when DB grows beyond 5000 rows; full scan below 5000 rows (<10ms)
    if total_rows <= 5000:
        rows = conn.execute(
            """
            SELECT offer_key, store_id, store, source_retailer, good_id,
                   title, norm_title, brand, amount, price, old_price, url, updated_at
            FROM external_store_offers
            WHERE price > 0
            ORDER BY updated_at DESC
            """
        ).fetchall()
    else:
        import re as _re

        norm_q = normalize_synonym_tokens(full_target_title)
        words = [w for w in _re.findall(r"[а-яa-z0-9]{3,}", norm_q) if not w.isdigit()]
        stems: List[str] = []
        for w in sorted(set(words), key=len, reverse=True)[:4]:
            stems.append(w[:5] if len(w) >= 6 else (w[:4] if len(w) >= 5 else w))
        if stems:
            like_clause = " OR ".join("norm_title LIKE ?" for _ in stems)
            params = [f"%{s}%" for s in stems]
            rows = conn.execute(
                f"""
                SELECT offer_key, store_id, store, source_retailer, good_id,
                       title, norm_title, brand, amount, price, old_price, url, updated_at
                FROM external_store_offers
                WHERE price > 0 AND ({like_clause})
                ORDER BY updated_at DESC
                LIMIT 2500
                """,
                tuple(params),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT offer_key, store_id, store, source_retailer, good_id,
                       title, norm_title, brand, amount, price, old_price, url, updated_at
                FROM external_store_offers
                WHERE price > 0
                ORDER BY updated_at DESC
                LIMIT 2500
                """
            ).fetchall()

    # Load rejected matches for this product (if any)
    source_key = normalize_title_for_match(full_target_title)
    rejected_set = {
        r[0]
        for r in conn.execute(
            "SELECT rejected_url_or_title FROM rejected_product_matches WHERE source_key = ?",
            (source_key,),
        ).fetchall()
    }

    best_by_store: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        _, store_id, store, source_retailer, good_id, row_title, row_norm, row_brand, row_amount, row_price, row_old, row_url, row_upd = r
        if exclude_id and store_id == exclude_id:
            continue
        if exclude_lower and (store or "").strip().lower() == exclude_lower:
            continue
        if rejected_set and ((row_url and row_url in rejected_set) or (row_norm and row_norm in rejected_set)):
            continue

        candidate_title = row_title
        if row_brand and row_brand.lower() not in row_title.lower():
            candidate_title = f"{row_title} {row_brand}"

        same_prod, same_vol = is_search_result_matching_product(
            candidate_title,
            row_amount or "",
            full_target_title,
            amount or "",
            target_price=target_price,
            candidate_price=row_price,
            require_volume=True,
        )
        if not same_prod or not same_vol:
            continue

        dedup_store_key = f"{store_id}|{source_retailer or ''}"
        price_rounded = int(round(float(row_price)))
        existing = best_by_store.get(dedup_store_key)
        if not existing or price_rounded < existing["price"]:
            best_by_store[dedup_store_key] = {
                "store": store,
                "storeId": store_id,
                "sourceRetailer": source_retailer,
                "goodId": good_id,
                "title": row_title,
                "brand": row_brand or "",
                "amount": row_amount or "",
                "price": price_rounded,
                "oldPrice": int(round(float(row_old))) if row_old else None,
                "url": row_url or "",
                "updatedAt": row_upd,
                "isVerifiedStoreOffer": True,
            }

    matched = sorted(best_by_store.values(), key=lambda x: x["price"])
    return matched[: max(1, int(limit))]


def get_external_offer_history(
    conn: sqlite3.Connection,
    url: str = "",
    store: str = "",
    title: str = "",
    days: int = 90,
) -> Dict[str, Any]:
    clean_url = _clean_offer_url(url)
    store_id = normalize_store_id(store, clean_url) if (store or clean_url) else ""
    norm_title = normalize_title_for_match(title)

    offer_row = None
    if clean_url:
        offer_row = conn.execute(
            """
            SELECT offer_key, store_id, store, title, amount, url, price, updated_at
            FROM external_store_offers
            WHERE url = ?
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            (clean_url,),
        ).fetchone()
    if not offer_row and store_id and norm_title:
        offer_row = conn.execute(
            """
            SELECT offer_key, store_id, store, title, amount, url, price, updated_at
            FROM external_store_offers
            WHERE store_id = ? AND norm_title = ?
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            (store_id, norm_title),
        ).fetchone()
    if not offer_row and norm_title:
        offer_row = conn.execute(
            """
            SELECT offer_key, store_id, store, title, amount, url, price, updated_at
            FROM external_store_offers
            WHERE norm_title = ?
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            (norm_title,),
        ).fetchone()

    cutoff_day: Optional[str] = None
    if days and days > 0:
        cutoff_day = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()[:10]

    points: List[Dict[str, Any]] = []
    if offer_row:
        offer_key, r_store_id, r_store, r_title, r_amount, r_url, r_price, _ = offer_row
        params: List[Any] = [offer_key]
        where_sql = "offer_key = ? AND price > 0"
        if cutoff_day:
            where_sql += " AND observed_day >= ?"
            params.append(cutoff_day)
        hist_rows = conn.execute(
            f"""
            SELECT price, old_price, observed_day, observed_at
            FROM external_price_history
            WHERE {where_sql}
            ORDER BY observed_day ASC
            LIMIT 1000
            """,
            tuple(params),
        ).fetchall()
        for pr, old_pr, obs_day, obs_at in hist_rows:
            points.append(
                {
                    "price": round(float(pr), 2),
                    "oldPrice": round(float(old_pr), 2) if old_pr else None,
                    "accountId": r_store,
                    "date": obs_day,
                    "ts": obs_at,
                }
            )
    else:
        offer_key = ""
        r_store_id = store_id
        r_store = store or ""
        r_title = title or ""
        r_amount = ""
        r_url = clean_url

    daily_avg = [
        {
            "date": pt["date"],
            "ts": pt["ts"],
            "price": pt["price"],
            "minPrice": pt["price"],
            "maxPrice": pt["price"],
            "count": 1,
        }
        for pt in points
    ]
    all_prices = [pt["price"] for pt in points if pt.get("price") and pt["price"] > 0]
    if all_prices:
        stats = {
            "minPrice": round(min(all_prices), 2),
            "maxPrice": round(max(all_prices), 2),
            "avgPrice": round(sum(all_prices) / len(all_prices), 2),
            "lastPrice": round(all_prices[-1], 2),
            "count": len(all_prices),
        }
    else:
        stats = {
            "minPrice": None,
            "maxPrice": None,
            "avgPrice": None,
            "lastPrice": None,
            "count": 0,
        }

    return {
        "offerKey": offer_key,
        "storeId": r_store_id,
        "store": r_store,
        "title": r_title,
        "amount": r_amount,
        "url": r_url,
        "days": days,
        "points": points,
        "dailyAvg": daily_avg,
        "stats": stats,
    }
def add_rejected_product_match(
    conn: sqlite3.Connection,
    source_title: str,
    rejected_url: str = "",
    rejected_title: str = "",
) -> Dict[str, Any]:
    source_key = normalize_title_for_match(source_title)
    if not source_key:
        return {"saved": 0, "sourceKey": ""}
    now_iso = datetime.now(timezone.utc).isoformat()
    targets: List[str] = []
    clean_url = _clean_offer_url(rejected_url)
    if clean_url:
        targets.append(clean_url)
    norm_rej = normalize_title_for_match(rejected_title)
    if norm_rej:
        targets.append(norm_rej)
    saved = 0
    for t in targets:
        conn.execute(
            """
            INSERT OR REPLACE INTO rejected_product_matches (source_key, rejected_url_or_title, created_at)
            VALUES (?, ?, ?)
            """,
            (source_key, t, now_iso),
        )
        saved += 1
    return {"saved": saved, "sourceKey": source_key, "rejected": targets}


def list_rejected_product_matches(conn: sqlite3.Connection, source_title: str) -> List[str]:
    source_key = normalize_title_for_match(source_title)
    if not source_key:
        return []
    rows = conn.execute(
        "SELECT rejected_url_or_title FROM rejected_product_matches WHERE source_key = ?",
        (source_key,),
    ).fetchall()
    return [r[0] for r in rows if r and r[0]]
