import os
import tempfile
import unittest

import db
import matcher


class TestPriceAccuracyGuard(unittest.TestCase):
    def test_matcher_require_volume_rejects_weightless_candidate(self):
        res = matcher.is_search_result_matching_product(
            "Горошек зелёный молодой Бондюэль",
            "",
            "Горошек зелёный молодой Бондюэль",
            "400 г",
            require_volume=True,
        )
        self.assertFalse(res.is_same_volume)
        self.assertEqual(res.match_quality, "similar")
        self.assertEqual(res.mismatch_reason, "volume_missing")

    def test_sqlite_match_filters_price_anomaly_and_missing_volume(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "test_accuracy.db")
            db.init_db(db_path)
            with db.get_db_connection(db_path) as conn:
                db.upsert_external_store_offers_batch(
                    conn,
                    [
                        {
                            "store": "Купер",
                            "title": "Горошек зелёный молодой Бондюэль 400 г",
                            "amount": "400 г",
                            "price": 25,
                            "url": "https://kuper.ru/products/bonduelle-bogus",
                        },
                        {
                            "store": "Магнит",
                            "title": "Горошек зелёный молодой Бондюэль",
                            "amount": "",
                            "price": 179,
                            "url": "https://magnit.ru/product/bonduelle-no-weight",
                        },
                        {
                            "store": "Пятёрочка",
                            "title": "Горошек зелёный молодой Бондюэль 400 г",
                            "amount": "400 г",
                            "price": 189,
                            "url": "https://5ka.ru/product/bonduelle-400",
                        },
                    ],
                )
                conn.commit()
                matched = db.find_matching_external_store_offers(
                    conn,
                    title="Горошек зелёный молодой «Бондюэль» 400 г",
                    amount="400 г",
                    target_price=255,
                )
                self.assertEqual(len(matched), 1)
                self.assertEqual(matched[0]["store"], "Пятёрочка")
                self.assertEqual(matched[0]["price"], 189)


if __name__ == "__main__":
    unittest.main()
