"""
Lavka Quality Shield — Price History, Watchlist & Cart Snapshot Router
"""

import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

_ITEMS_MAX_KW = {"max_length": 500} if hasattr(BaseModel, "model_validate") else {"max_items": 500}

import db
from security import verify_trusted_extension_request

router = APIRouter()


class PriceItemInput(BaseModel):
    slug: str
    title: Optional[str] = ""
    price: float
    oldPrice: Optional[float] = None
    amount: Optional[str] = ""
    competitorMinPrice: Optional[float] = None
    competitorSummary: Optional[str] = None
    competitorOffers: Optional[List[Dict[str, Any]]] = None


class RecordPricesRequest(BaseModel):
    accountId: str = "Аккаунт #1"
    items: List[PriceItemInput] = Field(default_factory=list, **_ITEMS_MAX_KW)


class WatchlistToggleRequest(BaseModel):
    slug: str
    title: Optional[str] = ""
    amount: Optional[str] = ""
    price: Optional[float] = None
    targetPrice: Optional[float] = None
    watch: Optional[bool] = None


class CartItemModel(BaseModel):
    slug: str
    title: str
    qty: int = 1
    price: float = 0.0
    oldPrice: Optional[float] = None
    amount: Optional[str] = ""
    imageKey: Optional[str] = None


class SaveCartSnapshotRequest(BaseModel):
    accountId: str = "Аккаунт #1"
    items: List[CartItemModel] = Field(default_factory=list, **_ITEMS_MAX_KW)
    totalPrice: float = 0.0


@router.post("/api/price/record", dependencies=[Depends(verify_trusted_extension_request)])
def record_prices_endpoint(req: RecordPricesRequest):
    if not req.items:
        return {"status": "empty", "updated": 0, "summaries": {}}
    summaries: Dict[str, Any] = {}
    with db.get_db_connection() as conn:
        for item in req.items:
            if not item.slug or item.price <= 0:
                continue
            summary = db.upsert_price_observation_sync(
                conn=conn,
                slug=item.slug,
                title=item.title or item.slug,
                account_id=req.accountId,
                price=item.price,
                old_price=item.oldPrice,
                amount=item.amount,
                competitor_min=item.competitorMinPrice,
                competitor_summary=item.competitorSummary,
                competitor_offers=item.competitorOffers,
            )
            summaries[summary["slug"]] = summary
        conn.commit()
    db.log_event("PRICE_DB", f"Recorded {len(summaries)} price(s) for account '{req.accountId}'")
    return {"status": "ok", "updated": len(summaries), "summaries": summaries}


@router.get("/api/price/product/{slug}", dependencies=[Depends(verify_trusted_extension_request)])
def get_product_price_summary(slug: str, title: Optional[str] = None):
    clean_slug = slug.strip().lower()
    with db.get_db_connection() as conn:
        row = db.find_existing_summary_row_by_slug_or_title(conn, clean_slug, title)
        if not row:
            return {"status": "not_found", "slug": clean_slug}
        accounts = json.loads(row[11] or "{}")
        if isinstance(accounts, dict):
            accounts.pop("Гость (без куки)", None)
        w_row = db.find_watchlist_row_by_slug_or_title(conn, row[0], row[1])
        return {
            "status": "ok",
            "summary": {
                "slug": row[0],
                "title": row[1],
                "amount": row[2],
                "minPrice": row[3],
                "maxPrice": row[4],
                "avgPrice": row[5],
                "lastPrice": row[6],
                "competitorMinPrice": row[8],
                "competitorSummary": row[9],
                "competitorOffers": json.loads(row[10] or "[]"),
                "accounts": accounts,
                "history": json.loads(row[12] or "[]"),
                "isWatched": bool(w_row),
                "targetPrice": w_row[4] if w_row else None,
                "updatedAt": row[13],
            },
        }


@router.get("/api/price/history/{slug}", dependencies=[Depends(verify_trusted_extension_request)])
def get_product_price_history(
    slug: str,
    title: Optional[str] = None,
    days: int = Query(90, ge=0, le=3650),
    accountId: Optional[str] = None,
):
    with db.get_db_connection() as conn:
        series = db.get_price_history_series(
            conn=conn,
            slug=slug,
            title=title,
            days=days,
            account_id=accountId,
        )
    return {"status": "ok", **series}


@router.get("/api/price/list", dependencies=[Depends(verify_trusted_extension_request)])
def list_tracked_prices(limit: int = Query(200, ge=1, le=2000)):
    items = []
    with db.get_db_connection() as conn:
        watched_slugs = {
            row[0] for row in conn.execute("SELECT slug FROM price_watchlist").fetchall()
        }
        rows = conn.execute(
            """
            SELECT slug, title, amount, min_price, max_price, avg_price, last_price,
                   competitor_min_price, competitor_summary, competitor_offers_json,
                   accounts_json, history_json, updated_at
            FROM product_price_summary
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        for r in rows:
            accounts = json.loads(r[10] or "{}")
            if isinstance(accounts, dict):
                accounts.pop("Гость (без куки)", None)
            items.append(
                {
                    "slug": r[0],
                    "title": r[1],
                    "amount": r[2],
                    "minPrice": r[3],
                    "maxPrice": r[4],
                    "avgPrice": r[5],
                    "lastPrice": r[6],
                    "competitorMinPrice": r[7],
                    "competitorSummary": r[8],
                    "competitorOffers": json.loads(r[9] or "[]"),
                    "accounts": accounts,
                    "history": json.loads(r[11] or "[]"),
                    "isWatched": r[0] in watched_slugs,
                    "updatedAt": r[12],
                }
            )
    return {"status": "ok", "count": len(items), "items": items}


@router.get("/api/watchlist", dependencies=[Depends(verify_trusted_extension_request)])
def list_watchlist_endpoint(limit: int = Query(200, ge=1, le=500)):
    with db.get_db_connection() as conn:
        items = db.list_watchlist_items(conn, limit=limit)
    return {"status": "ok", "count": len(items), "items": items}


@router.post("/api/watchlist/toggle", dependencies=[Depends(verify_trusted_extension_request)])
def toggle_watchlist_endpoint(req: WatchlistToggleRequest):
    clean_slug = (req.slug or "").strip().lower()
    if not clean_slug:
        return {"status": "error", "error": "slug is required"}
    with db.get_db_connection() as conn:
        existing = db.find_watchlist_row_by_slug_or_title(conn, clean_slug, req.title)
        should_watch = (not bool(existing)) if req.watch is None else bool(req.watch)
        if should_watch:
            item = db.upsert_watchlist_item(
                conn=conn,
                slug=clean_slug,
                title=req.title or "",
                amount=req.amount or "",
                current_price=req.price,
                target_price=req.targetPrice,
            )
            conn.commit()
            db.log_event("WATCHLIST", f"Added '{item['title']}' ({item['slug']}) to watchlist")
            return {"status": "ok", "watched": True, "item": item}
        else:
            removed = db.delete_watchlist_item(conn, clean_slug, req.title)
            conn.commit()
            db.log_event("WATCHLIST", f"Removed '{clean_slug}' from watchlist")
            return {"status": "ok", "watched": False, "removed": removed, "slug": clean_slug}


@router.delete("/api/watchlist/{slug}", dependencies=[Depends(verify_trusted_extension_request)])
def delete_watchlist_endpoint(slug: str):
    clean_slug = slug.strip().lower()
    with db.get_db_connection() as conn:
        removed = db.delete_watchlist_item(conn, clean_slug)
        conn.commit()
    db.log_event("WATCHLIST", f"Deleted '{clean_slug}' from watchlist")
    return {"status": "ok", "removed": removed, "slug": clean_slug}


@router.post("/api/cart/save", dependencies=[Depends(verify_trusted_extension_request)])
def save_cart_snapshot_endpoint(req: SaveCartSnapshotRequest):
    now_iso = datetime.now(timezone.utc).isoformat()
    acc = (req.accountId or "Аккаунт #1").strip()
    items_list = [i.model_dump() if hasattr(i, "model_dump") else i.dict() for i in req.items]
    calc_total = round(sum((i.price or 0) * (i.qty or 1) for i in req.items), 2)
    final_total = req.totalPrice if req.totalPrice > 0 else calc_total

    with db.get_db_connection() as conn:
        for cid in ("latest", f"cart_{acc}"):
            conn.execute(
                """
                INSERT OR REPLACE INTO saved_carts (cart_id, account_id, items_json, total_price, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (cid, acc, json.dumps(items_list, ensure_ascii=False), final_total, now_iso),
            )
        for item in req.items:
            if item.slug and item.price > 0:
                db.upsert_price_observation_sync(
                    conn=conn,
                    slug=item.slug,
                    title=item.title,
                    account_id=acc,
                    price=item.price,
                    old_price=item.oldPrice,
                    amount=item.amount,
                )
        conn.commit()
    db.log_event("CART_SAVE", f"Saved cart snapshot for '{acc}' ({len(items_list)} items, {final_total} ₽)")
    return {"status": "ok", "accountId": acc, "itemsCount": len(items_list), "totalPrice": final_total}


@router.get("/api/cart/latest", dependencies=[Depends(verify_trusted_extension_request)])
def get_latest_cart_snapshot():
    with db.get_db_connection() as conn:
        row = conn.execute(
            "SELECT cart_id, account_id, items_json, total_price, updated_at FROM saved_carts WHERE cart_id = 'latest'"
        ).fetchone()
        all_rows = conn.execute(
            "SELECT cart_id, account_id, items_json, total_price, updated_at FROM saved_carts WHERE cart_id != 'latest' ORDER BY updated_at DESC"
        ).fetchall()

        if not row:
            return {"status": "empty", "latest": None, "cartsByAccount": []}

        items = json.loads(row[2] or "[]")
        for it in items:
            s_row = db.find_existing_summary_row_by_slug_or_title(
                conn, str(it.get("slug", "")).lower(), it.get("title")
            )
            if s_row:
                accounts = json.loads(s_row[11] or "{}")
                if isinstance(accounts, dict):
                    accounts.pop("Гость (без куки)", None)
                it["minPrice"] = s_row[3]
                it["avgPrice"] = s_row[5]
                it["competitorMinPrice"] = s_row[8]
                it["competitorSummary"] = s_row[9]
                it["competitorOffers"] = json.loads(s_row[10] or "[]")
                it["accounts"] = accounts

        carts_by_account = [
            {
                "cartId": r[0],
                "accountId": r[1],
                "items": json.loads(r[2] or "[]"),
                "totalPrice": r[3],
                "updatedAt": r[4],
            }
            for r in all_rows
        ]

        return {
            "status": "ok",
            "latest": {
                "accountId": row[1],
                "items": items,
                "totalPrice": row[3],
                "updatedAt": row[4],
            },
            "cartsByAccount": carts_by_account,
        }


class ProductStoreLinkInput(BaseModel):
    storeId: str
    storeName: Optional[str] = ""
    url: str
    title: Optional[str] = ""
    sourceRetailer: Optional[str] = None
    lastPrice: Optional[float] = None
    lastCheckedAt: Optional[str] = None


class SaveProductStoreLinksRequest(BaseModel):
    slug: str
    links: List[ProductStoreLinkInput] = Field(default_factory=list)


@router.get("/api/price/links/{slug}", dependencies=[Depends(verify_trusted_extension_request)])
def get_product_links_endpoint(slug: str):
    clean_slug = slug.strip().lower()
    with db.get_db_connection() as conn:
        links = db.get_product_store_links(conn, clean_slug)
    return {"status": "ok", "slug": clean_slug, "links": links}


@router.post("/api/price/links", dependencies=[Depends(verify_trusted_extension_request)])
def save_product_links_endpoint(req: SaveProductStoreLinksRequest):
    clean_slug = req.slug.strip().lower()
    raw_links = [
        it.model_dump() if hasattr(it, "model_dump") else it.dict()
        for it in (req.links or [])
    ]
    with db.get_db_connection() as conn:
        saved = db.upsert_product_store_links(conn, clean_slug, raw_links)
        conn.commit()
        links = db.get_product_store_links(conn, clean_slug)
    db.log_event("PRICE_DB", f"Saved {saved} direct store link(s) for '{clean_slug}'")
    return {"status": "ok", "slug": clean_slug, "saved": saved, "links": links}


@router.delete("/api/price/links/{slug}/{store_id}", dependencies=[Depends(verify_trusted_extension_request)])
def delete_product_link_endpoint(slug: str, store_id: str):
    clean_slug = slug.strip().lower()
    clean_store = store_id.strip().lower()
    with db.get_db_connection() as conn:
        deleted = db.delete_product_store_link(conn, clean_slug, clean_store)
        conn.commit()
    return {"status": "ok", "slug": clean_slug, "storeId": clean_store, "deleted": deleted}
class ExternalOfferInput(BaseModel):
    store: Optional[str] = ""
    sourceRetailer: Optional[str] = None
    goodId: Optional[str] = None
    title: str
    brand: Optional[str] = ""
    amount: Optional[str] = ""
    price: float
    oldPrice: Optional[float] = None
    url: Optional[str] = ""


class ExternalOffersBatchRequest(BaseModel):
    store: Optional[str] = ""
    offers: List[ExternalOfferInput] = Field(default_factory=list, **_ITEMS_MAX_KW)


class ExternalOffersMatchRequest(BaseModel):
    title: str
    brand: Optional[str] = ""
    amount: Optional[str] = ""
    excludeStore: Optional[str] = ""
    targetPrice: Optional[float] = None
    limit: int = Field(50, ge=1, le=200)


@router.post("/api/external-offers/batch", dependencies=[Depends(verify_trusted_extension_request)])
def save_external_offers_batch_endpoint(req: ExternalOffersBatchRequest):
    raw_offers = [
        it.model_dump() if hasattr(it, "model_dump") else it.dict()
        for it in (req.offers or [])
    ]
    with db.get_db_connection() as conn:
        result = db.upsert_external_store_offers_batch(
            conn=conn,
            offers=raw_offers,
            default_store=req.store or "",
        )
        conn.commit()
    db.log_event(
        "EXT_OFFERS",
        f"Saved {result['savedCount']} external offer(s) (total in SQLite: {result['totalInSqlite']})",
    )
    return {"status": "ok", **result}


@router.post("/api/external-offers/match", dependencies=[Depends(verify_trusted_extension_request)])
def match_external_offers_endpoint(req: ExternalOffersMatchRequest):
    with db.get_db_connection() as conn:
        offers = db.find_matching_external_store_offers(
            conn=conn,
            title=req.title,
            brand=req.brand or "",
            amount=req.amount or "",
            exclude_store=req.excludeStore or "",
            target_price=req.targetPrice,
            limit=req.limit,
        )
        total = db.count_external_store_offers(conn)
    return {"status": "ok", "count": len(offers), "offers": offers, "totalInSqlite": total}


@router.get("/api/external-offers/history", dependencies=[Depends(verify_trusted_extension_request)])
def get_external_offer_history_endpoint(
    url: Optional[str] = None,
    store: Optional[str] = None,
    title: Optional[str] = None,
    days: int = Query(90, ge=0, le=3650),
):
    with db.get_db_connection() as conn:
        series = db.get_external_offer_history(
            conn=conn,
            url=url or "",
            store=store or "",
            title=title or "",
            days=days,
        )
    return {"status": "ok", **series}
class RejectCompetitorMatchRequest(BaseModel):
    sourceTitle: str
    rejectedUrl: Optional[str] = ""
    rejectedTitle: Optional[str] = ""


@router.post("/api/external-offers/reject-match", dependencies=[Depends(verify_trusted_extension_request)])
def reject_competitor_match_endpoint(req: RejectCompetitorMatchRequest):
    with db.get_db_connection() as conn:
        result = db.add_rejected_product_match(
            conn=conn,
            source_title=req.sourceTitle,
            rejected_url=req.rejectedUrl or "",
            rejected_title=req.rejectedTitle or "",
        )
        conn.commit()
    db.log_event("EXT_OFFERS", f"Rejected match for '{result.get('sourceKey', '')}': {len(result.get('rejected', []))} key(s)")
    return {"status": "ok", **result}


@router.get("/api/external-offers/rejected", dependencies=[Depends(verify_trusted_extension_request)])
def list_rejected_matches_endpoint(title: str = Query(..., min_length=1)):
    with db.get_db_connection() as conn:
        items = db.list_rejected_product_matches(conn, title)
    return {"status": "ok", "count": len(items), "items": items}
