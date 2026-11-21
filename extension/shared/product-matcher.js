/**
 * Lavka Quality Shield — Pure Product Normalization & Matching Module (shared/product-matcher.js)
 * Works in Chrome Extension Service Worker (importScripts), Content Scripts, and Node.js tests.
 */
(function (root) {
  'use strict';

  const SUGAR_FREE_REGEX =
    /(без\s+сахара|без\s+добавленного\s+сахара|\bzero\b|\bзеро\b|\blight\b|\bлайт\b|\bdiet\b|0\s*%\s*сахара|0\s+сахара|на\s+стевии|подсластител)/i;

  const FLAVOR_AND_TYPE_MODIFIERS = [
    'ваниль',
    'вишн',
    'черешн',
    'лимон',
    'лайм',
    'манго',
    'маракуй',
    'апельсин',
    'персик',
    'малин',
    'клубник',
    'земляник',
    'смородин',
    'черник',
    'яблок',
    'груш',
    'ананас',
    'грейпфрут',
    'тархун',
    'дюшес',
    'байкал',
    'буратино',
    'крем-сода',
    'карамел',
    'кокос',
    'миндал',
    'фундук',
    'фисташк',
    'банан',
    'шоколад',
    'какао',
    'кофе',
    'матча',
    'имбир',
    'мята',
    'мятн',
    'солен',
    'копчен',
    'остр',
    'сырн',
    'гриб',
    'сметан',
    'зелен',
    'краб',
    'бекон',
    'паприк',
    'безлактоз',
    'топлен',
    'обезжир',
    'кури',
    'говяд',
    'свин',
    'индейк',
    'утк',
    'телят',
    'баранин',
    'лосос',
    'креветк',
    'тунец'
  ];

  // Сорт, линейка и степень зрелости (симметричная проверка: различие => не точное совпадение)
  const GRADE_AND_LINE_MODIFIERS = [
    'молод',
    'нежн',
    'мозгов',
    'отборн',
    'премиум',
    'экстра',
    'элит',
    'высш',
    'перв',
    'фермерск',
    'био',
    'органик',
    'детск',
    'халяль',
    'веган',
    'постн',
    'диетич',
    'эко',
    'деликатес',
    'традицион',
    'домашн',
    'деревенск',
    'сладк',
    'сахарн',
    'малосол',
    'слабосол'
  ];

  // Вид обработки, нарезки и заливки (симметричная проверка: различие => mismatch)
  const PROCESSING_MODIFIERS = [
    'заморож',
    'охлажд',
    'консервир',
    'сушен',
    'вялен',
    'маринов',
    'квашен',
    'цельн',
    'рублен',
    'резан',
    'кусочк',
    'дольк',
    'кольц',
    'нарезк',
    'филе',
    'фарш',
    'тушк',
    'в масле',
    'в собственном соку',
    'в томат',
    'в рассол',
    'в сироп'
  ];

  // Упаковка (если явно указана)
  const PACKAGING_MODIFIERS = [
    'стекл',
    'жест'
  ];

  // Расширяемый словарь популярных брендов и СТМ сетей (канонический ключ -> синонимы)
  const KNOWN_BRAND_ALIASES = {
    bonduelle: ['bonduelle', 'бондюэль', 'бондюел'],
    '6_sotok': ['6 соток', 'шесть соток'],
    globus: ['глобус', 'globus'],
    global_village: ['global village', 'глобал вилладж'],
    krasnaya_tsena: ['красная цена'],
    moya_tsena: ['моя цена'],
    kazhdy_den: ['каждый день'],
    iz_lavki: ['из лавки'],
    vkusvill: ['вкусвилл', 'vkusvill'],
    dyadya_vanya: ['дядя ваня'],
    frau_marta: ['фрау марта', 'frau marta'],
    heinz: ['heinz', 'хайнц'],
    chernogolovka: ['черноголовка'],
    doshirak: ['доширак', 'doshirak'],
    rollton: ['роллтон', 'rollton'],
    prostokvashino: ['простоквашино'],
    domik_v_derevne: ['домик в деревне'],
    agusha: ['агуша'],
    frutonyanya: ['фрутоняня'],
    dobry: ['добрый'],
    coca_cola: ['coca-cola', 'кока-кола', 'coca cola'],
    pepsi: ['pepsi', 'пепси'],
    indilight: ['индилайт', 'indilight'],
    lamber: ['ламбер', 'lamber'],
    makfa: ['макфа', 'makfa'],
    barilla: ['barilla', 'барилла'],
    danone: ['danone', 'данон'],
    activia: ['активиа', 'активия', 'activia'],
    miratorg: ['мираторг'],
    cherkizovo: ['черкизово'],
    petelinka: ['петелинка'],
    ekoniva: ['эконива'],
    parmalat: ['parmalat', 'пармалат'],
    hochland: ['hochland', 'хохланд'],
    viola: ['viola', 'виола'],
    president: ['president', 'президент'],
    nescafe: ['nescafe', 'нескафе'],
    jacobs: ['jacobs', 'якобс'],
    lavazza: ['lavazza', 'лавацца'],
    greenfield: ['greenfield', 'гринфилд'],
    ahmad: ['ahmad', 'ахмад'],
    lays: ['lays', "lay's", 'лейс'],
    pringles: ['pringles', 'принглс'],
    '365_dney': ['365 дней'],
    zelenaya_liniya: ['зеленая линия'],
    market_perekrestok: ['маркет перекресток']
  };

  const GENERIC_STOP_WORDS = new Set([
    'напиток',
    'газированный',
    'сильногазированный',
    'среднегазированный',
    'слабогазированный',
    'негазированный',
    'безалкогольный',
    'фасованный',
    'упаковка',
    'пакет',
    'коробка',
    'продукт',
    'товар',
    'купить',
    'цена',
    'отзывы',
    'отзыв',
    'доставка',
    'москва',
    'лавка',
    'яндекс',
    'бзмж',
    'стм',
    'несоленое',
    'несоленый',
    'несоленая',
    'для',
    'или',
    'под',
    'над',
    'при'
  ]);

  function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function hasWordPrefix(textLower, stem) {
    if (!textLower || !stem) return false;
    const re = new RegExp(`(?:^|[^а-яa-z0-9])${escapeRegex(stem)}`, 'i');
    return re.test(textLower);
  }

  function extractKnownBrands(textLower) {
    if (!textLower) return [];
    const found = [];
    for (const [canonical, aliases] of Object.entries(KNOWN_BRAND_ALIASES)) {
      for (const alias of aliases) {
        const re = new RegExp(`(?:^|[^а-яa-z0-9])${escapeRegex(alias)}(?:$|[^а-яa-z0-9])`, 'i');
        if (re.test(textLower)) {
          found.push(canonical);
          break;
        }
      }
    }
    return found;
  }

  function normalizeTitleKey(rawTitle) {
    if (!rawTitle) return '';
    return String(rawTitle)
      .replace(/<[^>]*>/g, ' ')
      .replace(/[\u00ad\u200b\u00a0«»"'„“”]/g, ' ')
      .replace(/(?:,\s*|\s+)(?:\d+\s*[×xх*]\s*)?\d+(?:[.,]\d+)?\s*(?:г|гр|грамм|кг|мл|л|шт|уп|пак|рул|капс)\.?$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/ё/g, 'е');
  }

  function parseVolumeOrWeightGrams(rawStr) {
    if (!rawStr) return null;
    const s = String(rawStr).replace(/[\u00ad\u200b\u00a0]/g, ' ');
    const multi = s.match(
      /(\d+)\s*[×xх*]\s*(\d+(?:[.,]\d+)?)\s*(г|гр|грамм[а-я]*|кг|мл|л|литр[а-я]*)(?![а-яёa-z])/i
    );
    if (multi) {
      const cnt = parseInt(multi[1], 10) || 1;
      const val = parseFloat(multi[2].replace(',', '.'));
      const u = multi[3].toLowerCase();
      const mult = u.startsWith('кг') || u.startsWith('л') ? 1000 : 1;
      if (val > 0) return cnt * val * mult;
    }
    const single = s.match(
      /(?:^|[^\d.,])(\d+(?:[.,]\d+)?)\s*(г|гр|грамм[а-я]*|кг|мл|л|литр[а-я]*)(?![а-яёa-z])/i
    );
    if (single) {
      const val = parseFloat(single[1].replace(',', '.'));
      const u = single[2].toLowerCase();
      const mult = u.startsWith('кг') || u.startsWith('л') ? 1000 : 1;
      if (val > 0) return val * mult;
    }
    return null;
  }

  function computePricePerKgOrLiter(price, gramsOrMl) {
    const p = Number(price);
    const g = Number(gramsOrMl);
    if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(g) || g <= 0) return null;
    return Math.round((p / g) * 1000);
  }

  function normalizeSynonymTokens(text) {
    let s = String(text || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/\bcola\b/g, 'кола')
      .replace(/\bcoca[\s-]*кола\b/g, 'coca-cola кока-кола')
      .replace(/\boriginal\b/g, 'оригинал original')
      .replace(/\bclassic\b/g, 'классик classic')
      .replace(/\bzero\b/g, 'без сахара zero зеро');

    // Приводим латинские и кириллические варианты известных брендов к единому токену
    for (const [canonical, aliases] of Object.entries(KNOWN_BRAND_ALIASES)) {
      const token = canonical.replace(/_/g, '');
      for (const alias of aliases) {
        if (alias.includes(' ')) continue;
        const re = new RegExp(`(?:^|[^а-яa-z0-9])${escapeRegex(alias)}(?=$|[^а-яa-z0-9])`, 'gi');
        s = s.replace(re, (m) => {
          const prefix = m.slice(0, m.length - alias.length);
          return `${prefix}${token}`;
        });
      }
    }
    return s;
  }

  function isSearchResultMatchingProduct(resTitle, resSnippet, productTitle, productAmount = '', options = null) {
    const fullTarget = `${productTitle || ''} ${productAmount || ''}`.trim();
    const targetLower = fullTarget.toLowerCase().replace(/ё/g, 'е');
    const resTitleLower = String(resTitle || '').toLowerCase().replace(/ё/g, 'е');
    const resCombinedLower = `${resTitleLower} ${String(resSnippet || '').toLowerCase().replace(/ё/g, 'е')}`;

    const mismatch = (reason) => ({
      isSameProduct: false,
      isSameVolume: false,
      matchQuality: 'mismatch',
      mismatchReason: reason
    });

    // 1. ЖЁСТКАЯ ПРОВЕРКА «БЕЗ САХАРА / ZERO»
    const targetIsSugarFree = SUGAR_FREE_REGEX.test(targetLower);
    const resIsSugarFree = SUGAR_FREE_REGEX.test(resCombinedLower);
    const resTitleIsSugarFree = SUGAR_FREE_REGEX.test(resTitleLower);

    if (targetIsSugarFree && !resIsSugarFree) {
      return mismatch('sugar_free_mismatch');
    }
    if (!targetIsSugarFree && resTitleIsSugarFree) {
      return mismatch('sugar_free_mismatch');
    }

    // 2. ПРОВЕРКА ВКУСОВЫХ И ВИДОВЫХ МОДИФИКАТОРОВ
    for (const mod of FLAVOR_AND_TYPE_MODIFIERS) {
      const targetHasMod = hasWordPrefix(targetLower, mod);
      const resTitleHasMod = hasWordPrefix(resTitleLower, mod);
      const resAnyHasMod = hasWordPrefix(resCombinedLower, mod);
      if (targetHasMod && !resAnyHasMod) {
        return mismatch(`flavor_mismatch:${mod}`);
      }
      if (!targetHasMod && resTitleHasMod) {
        return mismatch(`flavor_mismatch:${mod}`);
      }
    }

    // 3. СИММЕТРИЧНАЯ ПРОВЕРКА ВИДА ОБРАБОТКИ / НАРЕЗКИ / ЗАЛИВКИ (замороженный vs консервированный и т.д.)
    for (const mod of PROCESSING_MODIFIERS) {
      const targetHasMod = hasWordPrefix(targetLower, mod);
      const resTitleHasMod = hasWordPrefix(resTitleLower, mod);
      const resAnyHasMod = hasWordPrefix(resCombinedLower, mod);
      if (targetHasMod && !resAnyHasMod) {
        return mismatch(`processing_mismatch:${mod}`);
      }
      if (!targetHasMod && resTitleHasMod) {
        return mismatch(`processing_mismatch:${mod}`);
      }
    }

    // 4. СТРОГАЯ ПРОВЕРКА БРЕНДА / СТМ
    const targetBrands = extractKnownBrands(targetLower);
    const resTitleBrands = extractKnownBrands(resTitleLower);
    const resAnyBrands = extractKnownBrands(resCombinedLower);

    if (targetBrands.length > 0) {
      if (resAnyBrands.length === 0) {
        return mismatch('brand_mismatch');
      }
      const hasSharedBrand = targetBrands.some((b) => resAnyBrands.includes(b));
      if (!hasSharedBrand) {
        return mismatch('brand_mismatch');
      }
    } else if (resTitleBrands.length > 0) {
      return mismatch('brand_mismatch');
    }

    // 5. СИММЕТРИЧНАЯ ПРОВЕРКА МОДИФИКАТОРОВ СОРТА / ЛИНЕЙКИ / ЗРЕЛОСТИ И УПАКОВКИ
    let gradeOrPackDiffReason = null;
    for (const mod of GRADE_AND_LINE_MODIFIERS) {
      const targetHasMod = hasWordPrefix(targetLower, mod);
      const resTitleHasMod = hasWordPrefix(resTitleLower, mod);
      const resAnyHasMod = hasWordPrefix(resCombinedLower, mod);
      if (targetHasMod && !resAnyHasMod) {
        gradeOrPackDiffReason = `grade_mismatch:${mod}`;
        break;
      }
      if (!targetHasMod && resTitleHasMod) {
        gradeOrPackDiffReason = `grade_mismatch:${mod}`;
        break;
      }
    }
    if (!gradeOrPackDiffReason) {
      for (const mod of PACKAGING_MODIFIERS) {
        const targetHasMod = hasWordPrefix(targetLower, mod);
        const resTitleHasMod = hasWordPrefix(resTitleLower, mod);
        const resAnyHasMod = hasWordPrefix(resCombinedLower, mod);
        if (targetHasMod && !resAnyHasMod) {
          gradeOrPackDiffReason = `packaging_mismatch:${mod}`;
          break;
        }
        if (!targetHasMod && resTitleHasMod) {
          gradeOrPackDiffReason = `packaging_mismatch:${mod}`;
          break;
        }
      }
    }

    // 6. ПРОВЕРКА ЯДРА НАЗВАНИЯ И БРЕНДА (синхронизировано с Python: Math.ceil, порог >= 75%)
    const normTarget = normalizeSynonymTokens(targetLower);
    const normRes = normalizeSynonymTokens(resCombinedLower);

    const rawWords = normTarget.match(/[а-яa-z0-9]{3,}/g) || [];
    const coreTokens = [];
    for (const w of rawWords) {
      if (GENERIC_STOP_WORDS.has(w)) continue;
      if (['без', 'сахара', 'сахар', 'zero', 'зеро', 'литр', 'литра', 'литров', 'грамм', 'грамма'].includes(w)) {
        continue;
      }
      if (/^\d+(?:г|гр|кг|мл|л|шт|percent)?$/.test(w)) continue;
      if (!coreTokens.includes(w)) coreTokens.push(w);
    }

    if (coreTokens.length > 0) {
      let matchedCount = 0;
      for (const tok of coreTokens) {
        const stem = tok.length >= 6 ? tok.slice(0, 5) : (tok.length >= 5 ? tok.slice(0, 4) : tok);
        if (normRes.includes(stem)) {
          matchedCount += 1;
        }
      }
      // Если отличие только в модификаторе сорта/линейки, проверяем ядро хотя бы на 60%, чтобы отличить 'similar' от 'mismatch'
      const ratioThreshold = gradeOrPackDiffReason ? 0.6 : 0.75;
      const required = coreTokens.length === 1 ? 1 : Math.max(2, Math.ceil(coreTokens.length * ratioThreshold));
      if (matchedCount < Math.min(required, coreTokens.length)) {
        return mismatch('core_tokens_mismatch');
      }
    }

    // 7. ПРОВЕРКА ОБЪЁМА / ВЕСА (суженный допуск 0.88–1.14 для точного совпадения)
    const targetGrams = parseVolumeOrWeightGrams(productAmount) || parseVolumeOrWeightGrams(productTitle);
    const resGrams = parseVolumeOrWeightGrams(resTitle) || parseVolumeOrWeightGrams(resSnippet);
    const requireVolume = Boolean(options && options.requireVolume);
    let isSameVolume = true;
    let volumeMismatchReason = 'volume_mismatch';
    if (targetGrams && resGrams) {
      const ratio = resGrams / targetGrams;
      if (ratio < 0.88 || ratio > 1.14) {
        isSameVolume = false;
      }
    } else if (requireVolume && targetGrams && !resGrams) {
      isSameVolume = false;
      volumeMismatchReason = 'volume_missing';
    }

    const candidatePrice = options && Number(options.candidatePrice) > 0 ? Number(options.candidatePrice) : null;
    const targetPrice = options && Number(options.targetPrice) > 0 ? Number(options.targetPrice) : null;
    const candidatePricePerUnit = computePricePerKgOrLiter(candidatePrice, resGrams);

    // Если отличается сорт/линейка или упаковка — это НЕ точное совпадение, а 'similar'
    if (gradeOrPackDiffReason) {
      const res = {
        isSameProduct: false,
        isSameVolume,
        matchQuality: 'similar',
        mismatchReason: gradeOrPackDiffReason
      };
      if (candidatePricePerUnit) res.pricePerKgOrL = candidatePricePerUnit;
      return res;
    }

    // Если отличается только вес/объём (или вес не указан при requireVolume) — matchQuality: 'similar'
    if (!isSameVolume) {
      const res = {
        isSameProduct: true,
        isSameVolume: false,
        matchQuality: 'similar',
        mismatchReason: volumeMismatchReason
      };
      if (candidatePricePerUnit) res.pricePerKgOrL = candidatePricePerUnit;
      return res;
    }

    // 8. ЗАЩИТА ОТ АНОМАЛЬНЫХ ЦЕН (> 2.2x при совпадающем весе)
    if (targetPrice && candidatePrice) {
      const priceRatio = Math.max(targetPrice, candidatePrice) / Math.min(targetPrice, candidatePrice);
      if (priceRatio > 2.2) {
        const res = {
          isSameProduct: false,
          isSameVolume: true,
          matchQuality: 'similar',
          mismatchReason: 'price_anomaly',
          warning: 'проверьте сорт'
        };
        if (candidatePricePerUnit) res.pricePerKgOrL = candidatePricePerUnit;
        return res;
      }
    }

    return {
      isSameProduct: true,
      isSameVolume: true,
      matchQuality: 'exact',
      mismatchReason: null
    };
  }

  function decodeHtmlEntities(str) {
    if (!str) return '';
    return String(str)
      .replace(/<[^>]+>/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const api = {
    SUGAR_FREE_REGEX,
    FLAVOR_AND_TYPE_MODIFIERS,
    GRADE_AND_LINE_MODIFIERS,
    PROCESSING_MODIFIERS,
    PACKAGING_MODIFIERS,
    KNOWN_BRAND_ALIASES,
    GENERIC_STOP_WORDS,
    extractKnownBrands,
    computePricePerKgOrLiter,
    normalizeTitleKey,
    parseVolumeOrWeightGrams,
    normalizeSynonymTokens,
    isSearchResultMatchingProduct,
    decodeHtmlEntities
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.LQS_MATCHER = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
