"""
Lavka Quality Shield — Exact Product & Modifier Matcher
Matches products across retailers strictly by sugar-free, flavor, grade/line,
processing, packaging, brand/STM, volume tolerance, and price anomaly guards.
"""

import math
import re
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple

REVIEW_SEARCH_SITES: List[Dict[str, str]] = [
    {"domain": "otzovik.com", "name": "Отзовик"},
    {"domain": "irecommend.ru", "name": "IRecommend"},
    {"domain": "rskrf.ru", "name": "Роскачество"},
    {"domain": "roscontrol.com", "name": "Росконтроль"},
    {"domain": "magnit.ru", "name": "Магнит"},
    {"domain": "5ka.ru", "name": "Пятёрочка"},
    {"domain": "vkusvill.ru", "name": "ВкусВилл"},
    {"domain": "perekrestok.ru", "name": "Перекрёсток"},
    {"domain": "auchan.ru", "name": "Ашан"},
    {"domain": "metro-cc.ru", "name": "МЕТРО"},
    {"domain": "globus.ru", "name": "Глобус"},
    {"domain": "mgnl.ru", "name": "Магнолия"},
    {"domain": "dixy.ru", "name": "Дикси"},
    {"domain": "chizhik.club", "name": "Чижик"},
    {"domain": "okeydostavka.ru", "name": "О’КЕЙ"},
    {"domain": "vprok.ru", "name": "Перекрёсток Впрок"},
    {"domain": "av.ru", "name": "Азбука Вкуса"},
    {"domain": "lenta.com", "name": "Лента"},
    {"domain": "ozon.ru", "name": "Ozon"},
    {"domain": "market.yandex.ru", "name": "Яндекс Маркет"},
    {"domain": "wildberries.ru", "name": "Wildberries"},
    {"domain": "kuper.ru", "name": "Купер"},
    {"domain": "sbermarket.ru", "name": "СберМаркет"},
    {"domain": "eda.yandex.ru", "name": "Яндекс Лавка / Еда"},
]


class ProductMatchResult(tuple):
    """
    2-tuple `(is_same_product, is_same_volume)` with extended attributes and dict-like access:
    `isSameProduct`, `isSameVolume`, `matchQuality` ('exact' | 'similar' | 'mismatch'),
    `mismatchReason`, `warning`, `pricePerKgOrL`.
    Keeps full backwards compatibility with `same_prod, same_vol = is_search_result_matching_product(...)`.
    """

    def __new__(
        cls,
        is_same_product: bool,
        is_same_volume: bool,
        match_quality: str = "mismatch",
        mismatch_reason: Optional[str] = None,
        warning: Optional[str] = None,
        price_per_kg_or_l: Optional[int] = None,
    ):
        obj = super().__new__(cls, (bool(is_same_product), bool(is_same_volume)))
        obj.is_same_product = bool(is_same_product)
        obj.is_same_volume = bool(is_same_volume)
        obj.isSameProduct = bool(is_same_product)
        obj.isSameVolume = bool(is_same_volume)
        obj.match_quality = match_quality
        obj.matchQuality = match_quality
        obj.mismatch_reason = mismatch_reason
        obj.mismatchReason = mismatch_reason
        obj.warning = warning
        obj.price_per_kg_or_l = price_per_kg_or_l
        obj.pricePerKgOrL = price_per_kg_or_l
        return obj

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "isSameProduct": self.isSameProduct,
            "isSameVolume": self.isSameVolume,
            "matchQuality": self.matchQuality,
            "mismatchReason": self.mismatchReason,
        }
        if self.warning:
            out["warning"] = self.warning
        if self.pricePerKgOrL is not None:
            out["pricePerKgOrL"] = self.pricePerKgOrL
        return out


def normalize_title_for_match(raw: Optional[str]) -> str:
    if not raw:
        return ""
    s = re.sub(r"[\u00ad\u200b\u00a0«»\"'„“”]", " ", str(raw))
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s


SUGAR_FREE_REGEX = re.compile(
    r"(без\s+сахара|без\s+добавленного\s+сахара|\bzero\b|\bзеро\b|\blight\b|\bлайт\b|\bdiet\b|0\s*%\s*сахара|0\s+сахара|на\s+стевии|подсластител)",
    re.IGNORECASE,
)

FLAVOR_AND_TYPE_MODIFIERS = [
    "ваниль",
    "вишн",
    "черешн",
    "лимон",
    "лайм",
    "манго",
    "маракуй",
    "апельсин",
    "персик",
    "малин",
    "клубник",
    "земляник",
    "смородин",
    "черник",
    "яблок",
    "груш",
    "ананас",
    "грейпфрут",
    "тархун",
    "дюшес",
    "байкал",
    "буратино",
    "крем-сода",
    "карамел",
    "кокос",
    "миндал",
    "фундук",
    "фисташк",
    "банан",
    "шоколад",
    "какао",
    "кофе",
    "матча",
    "имбир",
    "мята",
    "мятн",
    "солен",
    "копчен",
    "остр",
    "сырн",
    "гриб",
    "сметан",
    "зелен",
    "краб",
    "бекон",
    "паприк",
    "безлактоз",
    "топлен",
    "обезжир",
    "кури",
    "говяд",
    "свин",
    "индейк",
    "утк",
    "телят",
    "баранин",
    "лосос",
    "креветк",
    "тунец",
]

GRADE_AND_LINE_MODIFIERS = [
    "молод",
    "нежн",
    "мозгов",
    "отборн",
    "премиум",
    "экстра",
    "элит",
    "высш",
    "перв",
    "фермерск",
    "био",
    "органик",
    "детск",
    "халяль",
    "веган",
    "постн",
    "диетич",
    "эко",
    "деликатес",
    "традицион",
    "домашн",
    "деревенск",
    "сладк",
    "сахарн",
    "малосол",
    "слабосол",
]

PROCESSING_MODIFIERS = [
    "заморож",
    "охлажд",
    "консервир",
    "сушен",
    "вялен",
    "маринов",
    "квашен",
    "цельн",
    "рублен",
    "резан",
    "кусочк",
    "дольк",
    "кольц",
    "нарезк",
    "филе",
    "фарш",
    "тушк",
    "в масле",
    "в собственном соку",
    "в томат",
    "в рассол",
    "в сироп",
]

PACKAGING_MODIFIERS = [
    "стекл",
    "жест",
]

KNOWN_BRAND_ALIASES: Dict[str, List[str]] = {
    "bonduelle": ["bonduelle", "бондюэль", "бондюел"],
    "6_sotok": ["6 соток", "шесть соток"],
    "globus": ["глобус", "globus"],
    "global_village": ["global village", "глобал вилладж"],
    "krasnaya_tsena": ["красная цена"],
    "moya_tsena": ["моя цена"],
    "kazhdy_den": ["каждый день"],
    "iz_lavki": ["из лавки"],
    "vkusvill": ["вкусвилл", "vkusvill"],
    "dyadya_vanya": ["дядя ваня"],
    "frau_marta": ["фрау марта", "frau marta"],
    "heinz": ["heinz", "хайнц"],
    "chernogolovka": ["черноголовка"],
    "doshirak": ["доширак", "doshirak"],
    "rollton": ["роллтон", "rollton"],
    "prostokvashino": ["простоквашино"],
    "domik_v_derevne": ["домик в деревне"],
    "agusha": ["агуша"],
    "frutonyanya": ["фрутоняня"],
    "dobry": ["добрый"],
    "coca_cola": ["coca-cola", "кока-кола", "coca cola"],
    "pepsi": ["pepsi", "пепси"],
    "indilight": ["индилайт", "indilight"],
    "lamber": ["ламбер", "lamber"],
    "makfa": ["макфа", "makfa"],
    "barilla": ["barilla", "барилла"],
    "danone": ["danone", "данон"],
    "activia": ["активиа", "активия", "activia"],
    "miratorg": ["мираторг"],
    "cherkizovo": ["черкизово"],
    "petelinka": ["петелинка"],
    "ekoniva": ["эконива"],
    "parmalat": ["parmalat", "пармалат"],
    "hochland": ["hochland", "хохланд"],
    "viola": ["viola", "виола"],
    "president": ["president", "президент"],
    "nescafe": ["nescafe", "нескафе"],
    "jacobs": ["jacobs", "якобс"],
    "lavazza": ["lavazza", "лавацца"],
    "greenfield": ["greenfield", "гринфилд"],
    "ahmad": ["ahmad", "ахмад"],
    "lays": ["lays", "lay's", "лейс"],
    "pringles": ["pringles", "принглс"],
    "365_dney": ["365 дней"],
    "zelenaya_liniya": ["зеленая линия"],
    "market_perekrestok": ["маркет перекресток"],
}

GENERIC_STOP_WORDS = {
    "напиток",
    "газированный",
    "сильногазированный",
    "среднегазированный",
    "слабогазированный",
    "негазированный",
    "безалкогольный",
    "фасованный",
    "упаковка",
    "пакет",
    "коробка",
    "продукт",
    "товар",
    "купить",
    "цена",
    "отзывы",
    "отзыв",
    "доставка",
    "москва",
    "лавка",
    "яндекс",
    "бзмж",
    "стм",
    "несоленое",
    "несоленый",
    "несоленая",
    "для",
    "или",
    "под",
    "над",
    "при",
}


def _has_word_prefix(text_lower: str, stem: str) -> bool:
    if not text_lower or not stem:
        return False
    return bool(re.search(rf"(?:^|[^а-яa-z0-9]){re.escape(stem)}", text_lower, re.IGNORECASE))


def extract_known_brands(text_lower: str) -> List[str]:
    if not text_lower:
        return []
    found: List[str] = []
    for canonical, aliases in KNOWN_BRAND_ALIASES.items():
        for alias in aliases:
            if re.search(rf"(?:^|[^а-яa-z0-9]){re.escape(alias)}(?:$|[^а-яa-z0-9])", text_lower, re.IGNORECASE):
                found.append(canonical)
                break
    return found


def parse_volume_or_weight_grams(text: Optional[str]) -> Optional[float]:
    """Извлекает объём/вес в граммах или миллилитрах (например '1,5 л' -> 1500, '330 мл' -> 330)."""
    if not text:
        return None
    s = re.sub(r"[\u00ad\u200b\u00a0]", " ", str(text))
    m_multi = re.search(
        r"(\d+)\s*[×xх*]\s*(\d+(?:[.,]\d+)?)\s*(г|гр|грамм[а-я]*|кг|мл|л|литр[а-я]*)(?![а-яёa-z])",
        s,
        re.IGNORECASE,
    )
    if m_multi:
        cnt = int(m_multi.group(1))
        val = float(m_multi.group(2).replace(",", "."))
        u = m_multi.group(3).lower()
        mult = 1000.0 if u.startswith(("кг", "л")) else 1.0
        return cnt * val * mult

    m_single = re.search(
        r"(?:^|[^\d.,])(\d+(?:[.,]\d+)?)\s*(г|гр|грамм[а-я]*|кг|мл|л|литр[а-я]*)(?![а-яёa-z])",
        s,
        re.IGNORECASE,
    )
    if m_single:
        val = float(m_single.group(1).replace(",", "."))
        u = m_single.group(2).lower()
        mult = 1000.0 if u.startswith(("кг", "л")) else 1.0
        return val * mult
    return None


def compute_price_per_kg_or_liter(price: Optional[float], grams_or_ml: Optional[float]) -> Optional[int]:
    if price is None or grams_or_ml is None:
        return None
    try:
        p = float(price)
        g = float(grams_or_ml)
    except (TypeError, ValueError):
        return None
    if p <= 0 or g <= 0:
        return None
    return int(round((p / g) * 1000.0))


def build_full_product_search_query(
    title: str, brand: Optional[str] = None, amount: Optional[str] = None
) -> str:
    """
    Формирует ПОЛНЫЙ поисковый запрос товара без потери «без сахара», вкуса и объёма/веса!
    Если вес/объём (amount, например '1,5 л') не входит в title, добавляет его в конец.
    """
    q = re.sub(r"[\u00ad\u200b\u00a0«»\"'„“”]", " ", title or "")
    q = re.sub(r"\b(?:бзмж|стм)\b", " ", q, flags=re.IGNORECASE)
    q = re.sub(r"\s+", " ", q).strip()

    if brand:
        clean_brand = re.sub(r"[\u00ad\u200b\u00a0«»\"']", " ", brand).strip()
        if clean_brand and clean_brand.lower() not in q.lower():
            if clean_brand.lower() == "из лавки":
                q = f"{q} Из Лавки"
            else:
                q = f"{q} {clean_brand}"

    if amount:
        clean_amt = re.sub(r"[\u00ad\u200b\u00a0]", " ", amount).strip()
        if clean_amt:
            target_grams = parse_volume_or_weight_grams(clean_amt)
            query_grams = parse_volume_or_weight_grams(q)
            if not query_grams and clean_amt.lower() not in q.lower():
                q = f"{q} {clean_amt}"
            elif target_grams and query_grams and abs(target_grams - query_grams) > 5:
                q = f"{q} {clean_amt}"

    return re.sub(r"\s+", " ", q).strip()


def normalize_synonym_tokens(text: str) -> str:
    """Приводит частые англо-русские продуктовые синонимы и бренды к единому виду."""
    s = text.lower().replace("ё", "е")
    s = re.sub(r"\bcola\b", "кола", s)
    s = re.sub(r"\bcoca[\s-]*кола\b", "coca-cola кока-кола", s)
    s = re.sub(r"\boriginal\b", "оригинал original", s)
    s = re.sub(r"\bclassic\b", "классик classic", s)
    s = re.sub(r"\bzero\b", "без сахара zero зеро", s)

    for canonical, aliases in KNOWN_BRAND_ALIASES.items():
        token = canonical.replace("_", "")
        for alias in aliases:
            if " " in alias:
                continue
            pattern = rf"(^|[^а-яa-z0-9]){re.escape(alias)}(?=$|[^а-яa-z0-9])"
            s = re.sub(pattern, rf"\1{token}", s, flags=re.IGNORECASE)
    return s


def is_search_result_matching_product(
    res_title: str,
    res_snippet: str,
    product_title: str,
    product_amount: Optional[str] = None,
    target_price: Optional[float] = None,
    candidate_price: Optional[float] = None,
    require_volume: bool = False,
) -> ProductMatchResult:
    """
    Проверяет, относится ли найденный результат поиска ИМЕННО К ЭТОМУ ПРОДУКТУ.
    Возвращает ProductMatchResult — 2-tuple `(is_same_product, is_same_volume)` с расширенными полями:
    `matchQuality` ('exact' | 'similar' | 'mismatch'), `mismatchReason`, `warning`, `pricePerKgOrL`.
    """
    full_target = f"{product_title or ''} {product_amount or ''}".strip()
    target_lower = full_target.lower().replace("ё", "е")
    res_title_lower = (res_title or "").lower().replace("ё", "е")
    res_combined_lower = f"{res_title_lower} {(res_snippet or '').lower().replace('ё', 'е')}"

    def _mismatch(reason: str) -> ProductMatchResult:
        return ProductMatchResult(False, False, "mismatch", reason)

    # 1. ЖЁСТКАЯ ПРОВЕРКА МОДИФИКАТОРА «БЕЗ САХАРА / ZERO»
    target_is_sugar_free = bool(SUGAR_FREE_REGEX.search(target_lower))
    res_is_sugar_free = bool(SUGAR_FREE_REGEX.search(res_combined_lower))
    res_title_is_sugar_free = bool(SUGAR_FREE_REGEX.search(res_title_lower))

    if target_is_sugar_free and not res_is_sugar_free:
        return _mismatch("sugar_free_mismatch")

    if not target_is_sugar_free and res_title_is_sugar_free:
        return _mismatch("sugar_free_mismatch")

    # 2. ПРОВЕРКА ВКУСОВЫХ И ВИДОВЫХ МОДИФИКАТОРОВ
    for mod in FLAVOR_AND_TYPE_MODIFIERS:
        target_has_mod = _has_word_prefix(target_lower, mod)
        res_title_has_mod = _has_word_prefix(res_title_lower, mod)
        res_any_has_mod = _has_word_prefix(res_combined_lower, mod)
        if target_has_mod and not res_any_has_mod:
            return _mismatch(f"flavor_mismatch:{mod}")
        if not target_has_mod and res_title_has_mod:
            return _mismatch(f"flavor_mismatch:{mod}")

    # 3. СИММЕТРИЧНАЯ ПРОВЕРКА ВИДА ОБРАБОТКИ / НАРЕЗКИ / ЗАЛИВКИ
    for mod in PROCESSING_MODIFIERS:
        target_has_mod = _has_word_prefix(target_lower, mod)
        res_title_has_mod = _has_word_prefix(res_title_lower, mod)
        res_any_has_mod = _has_word_prefix(res_combined_lower, mod)
        if target_has_mod and not res_any_has_mod:
            return _mismatch(f"processing_mismatch:{mod}")
        if not target_has_mod and res_title_has_mod:
            return _mismatch(f"processing_mismatch:{mod}")

    # 4. СТРОГАЯ ПРОВЕРКА БРЕНДА / СТМ
    target_brands = extract_known_brands(target_lower)
    res_title_brands = extract_known_brands(res_title_lower)
    res_any_brands = extract_known_brands(res_combined_lower)

    if target_brands:
        if not res_any_brands:
            return _mismatch("brand_mismatch")
        if not any(b in res_any_brands for b in target_brands):
            return _mismatch("brand_mismatch")
    elif res_title_brands:
        return _mismatch("brand_mismatch")

    # 5. СИММЕТРИЧНАЯ ПРОВЕРКА СОРТА / ЛИНЕЙКИ / ЗРЕЛОСТИ И УПАКОВКИ
    grade_or_pack_diff_reason: Optional[str] = None
    for mod in GRADE_AND_LINE_MODIFIERS:
        target_has_mod = _has_word_prefix(target_lower, mod)
        res_title_has_mod = _has_word_prefix(res_title_lower, mod)
        res_any_has_mod = _has_word_prefix(res_combined_lower, mod)
        if target_has_mod and not res_any_has_mod:
            grade_or_pack_diff_reason = f"grade_mismatch:{mod}"
            break
        if not target_has_mod and res_title_has_mod:
            grade_or_pack_diff_reason = f"grade_mismatch:{mod}"
            break

    if not grade_or_pack_diff_reason:
        for mod in PACKAGING_MODIFIERS:
            target_has_mod = _has_word_prefix(target_lower, mod)
            res_title_has_mod = _has_word_prefix(res_title_lower, mod)
            res_any_has_mod = _has_word_prefix(res_combined_lower, mod)
            if target_has_mod and not res_any_has_mod:
                grade_or_pack_diff_reason = f"packaging_mismatch:{mod}"
                break
            if not target_has_mod and res_title_has_mod:
                grade_or_pack_diff_reason = f"packaging_mismatch:{mod}"
                break

    # 6. ПРОВЕРКА КЛЮЧЕВЫХ СЛОВ НАЗВАНИЯ И БРЕНДА (синхронизировано с JS: math.ceil, >= 75%)
    norm_target = normalize_synonym_tokens(target_lower)
    norm_res = normalize_synonym_tokens(res_combined_lower)

    raw_words = re.findall(r"[а-яa-z0-9]{3,}", norm_target)
    core_tokens: List[str] = []
    for w in raw_words:
        if w in GENERIC_STOP_WORDS:
            continue
        if w in ("без", "сахара", "сахар", "zero", "зеро", "литр", "литра", "литров", "грамм", "грамма"):
            continue
        if re.match(r"^\d+(?:г|гр|кг|мл|л|шт|percent)?$", w):
            continue
        if w not in core_tokens:
            core_tokens.append(w)

    if core_tokens:
        matched_tokens = 0
        for tok in core_tokens:
            stem = tok[:5] if len(tok) >= 6 else (tok[:4] if len(tok) >= 5 else tok)
            if stem in norm_res:
                matched_tokens += 1
        ratio_threshold = 0.6 if grade_or_pack_diff_reason else 0.75
        required = 1 if len(core_tokens) == 1 else max(2, math.ceil(len(core_tokens) * ratio_threshold))
        if matched_tokens < min(required, len(core_tokens)):
            return _mismatch("core_tokens_mismatch")

    # 7. ПРОВЕРКА СОВПАДЕНИЯ ОБЪЁМА / ВЕСА (суженный допуск 0.88–1.14)
    target_grams = parse_volume_or_weight_grams(product_amount) or parse_volume_or_weight_grams(product_title)
    res_grams = parse_volume_or_weight_grams(res_title) or parse_volume_or_weight_grams(res_snippet)

    is_same_volume = True
    volume_mismatch_reason = "volume_mismatch"
    if target_grams and res_grams:
        ratio = res_grams / target_grams if target_grams > 0 else 1.0
        if ratio < 0.88 or ratio > 1.14:
            is_same_volume = False
    elif require_volume and target_grams and not res_grams:
        is_same_volume = False
        volume_mismatch_reason = "volume_missing" 

    price_per_unit = compute_price_per_kg_or_liter(candidate_price, res_grams)

    if grade_or_pack_diff_reason:
        return ProductMatchResult(
            False,
            is_same_volume,
            "similar",
            grade_or_pack_diff_reason,
            price_per_kg_or_l=price_per_unit,
        )

    if not is_same_volume:
        return ProductMatchResult(
            True,
            False,
            "similar",
            volume_mismatch_reason,
            price_per_kg_or_l=price_per_unit,
        )

    # 8. ЗАЩИТА ОТ АНОМАЛЬНЫХ ЦЕН (> 2.2x при совпадающем весе)
    if target_price and candidate_price and target_price > 0 and candidate_price > 0:
        price_ratio = max(float(target_price), float(candidate_price)) / min(
            float(target_price), float(candidate_price)
        )
        if price_ratio > 2.2:
            return ProductMatchResult(
                False,
                True,
                "similar",
                "price_anomaly",
                warning="проверьте сорт",
                price_per_kg_or_l=price_per_unit,
            )

    return ProductMatchResult(True, True, "exact", None, price_per_kg_or_l=price_per_unit)


def detect_source_label(url: str) -> Tuple[str, bool]:
    try:
        host = urllib.parse.urlparse(url).netloc.lower()
    except Exception:
        host = ""
    for site in REVIEW_SEARCH_SITES:
        dom = site["domain"]
        if host == dom or host.endswith("." + dom):
            return site["name"], True
    return host.replace("www.", "") or "Веб", False


def extract_competitor_prices_from_sources(
    sources: List[Dict[str, Any]],
    lavka_price: Optional[float] = None,
    product_title: str = "",
    product_amount: Optional[str] = None,
) -> Tuple[Optional[float], str, List[Dict[str, Any]]]:
    """
    Извлекает цены в рублях и ссылки ТОЛЬКО из тех сниппетов конкурентов,
    которые прошли проверку полного совпадения продукта (включая «без сахара», сорт, бренд и объём/вес).
    """
    if not sources:
        return None, "", []
    found: List[Dict[str, Any]] = []
    for s in sources:
        raw_title = s.get("title") or ""
        snippet = s.get("snippet") or ""
        if product_title:
            same_prod, same_vol = is_search_result_matching_product(
                raw_title, snippet, product_title, product_amount
            )
            if not same_prod or not same_vol:
                continue

        text = f"{raw_title} {snippet}"
        source_name = s.get("source") or "Магазин"
        url = s.get("url") or ""
        for m in re.finditer(
            r"(?:от\s+|цена\s+|за\s+)?(\d{2,4}(?:[.,]\d{1,2})?)\s*(?:₽|руб\.?|р\.)(?![а-яa-z])",
            text,
            re.IGNORECASE,
        ):
            try:
                val = float(m.group(1).replace(",", "."))
                if 20 <= val <= 9500:
                    if lavka_price and (val < lavka_price * 0.35 or val > lavka_price * 3.0):
                        continue
                    found.append(
                        {
                            "store": source_name,
                            "price": int(round(val)),
                            "url": url,
                            "title": (raw_title or source_name)[:90],
                        }
                    )
            except Exception:
                pass
    if not found:
        return None, "", []
    found.sort(key=lambda x: x["price"])
    min_p = float(found[0]["price"])
    seen_stores = set()
    parts = []
    unique_offers: List[Dict[str, Any]] = []
    for item in found:
        st = item["store"]
        if st not in seen_stores:
            seen_stores.add(st)
            parts.append(f"{st}: ~{item['price']} ₽")
            unique_offers.append(item)
        if len(unique_offers) >= 5:
            break
    return min_p, ", ".join(parts[:3]), unique_offers
