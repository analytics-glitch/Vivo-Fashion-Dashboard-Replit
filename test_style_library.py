import asyncio
import io
from datetime import date, datetime, timezone
from types import SimpleNamespace
from unittest import TestCase, mock

from fastapi import HTTPException, Request, Response
from PIL import Image

import api_pg


def _png_bytes():
    out = io.BytesIO()
    Image.new("RGBA", (2, 2), "#fe5000").save(out, format="PNG")
    return out.getvalue()


class _Upload:
    filename = "style.png"
    content_type = "image/png"

    def __init__(self, content):
        self.content = content

    async def read(self, _limit):
        return self.content


class _Cursor:
    def __init__(self, row=None, image=None, rows=None, raise_unique=False):
        self.row = row
        self.image = image
        self.rows = rows or []
        self.raise_unique = raise_unique
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        if self.raise_unique and "INSERT INTO style_library" in sql:
            raise api_pg.psycopg2.errors.UniqueViolation()

    def fetchone(self):
        return self.image or self.row

    def fetchall(self):
        return self.rows

    def close(self):
        pass


class _Connection:
    def __init__(self, cursor):
        self._cursor = cursor
        self.committed = False
        self.rolled_back = False

    def cursor(self, **_kwargs):
        return self._cursor

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True

    def close(self):
        pass


class StyleLibraryTest(TestCase):
    @staticmethod
    def _request(path, method="GET", content_length=None):
        headers = [(b"cookie", b"session_token=test-session")]
        if content_length is not None:
            headers.append((b"content-length", str(content_length).encode()))
        scope = {
            "type": "http", "http_version": "1.1", "scheme": "https",
            "method": method, "path": path, "raw_path": path.encode(),
            "query_string": b"", "headers": headers,
            "client": ("127.0.0.1", 1), "server": ("testserver", 443),
        }
        return Request(scope)

    def test_taxonomy_dates_and_photo_signatures_are_validated(self):
        fields = api_pg._style_library_validate_fields(
            "Aster Dress", "AS-001", "Dresses", "Maxi Dresses", "Linen",
            "Vivo", "Active", "2026-09-01", "2026-09-02")
        self.assertEqual(fields[7], date(2026, 9, 1))
        self.assertEqual(
            api_pg._style_library_photo_type(
                "image/png", b"\x89PNG\r\n\x1a\nrest"),
            "image/png")
        with self.assertRaisesRegex(HTTPException, "Sub Category"):
            api_pg._style_library_validate_fields(
                "Aster", "AS-002", "Dresses", "Belts", "Linen",
                "Vivo", "Active", "", "")
        with self.assertRaisesRegex(HTTPException, "Adoption Date"):
            api_pg._style_library_validate_fields(
                "Aster", "AS-002", "Dresses", "Maxi Dresses", "Linen",
                "Vivo", "Active", "2026-09-02", "2026-09-01")
        with self.assertRaisesRegex(HTTPException, "valid JPG"):
            api_pg._style_library_photo_type("image/png", b"not-an-image")
        with self.assertRaisesRegex(HTTPException, "decoded safely"):
            api_pg._style_library_normalize_photo(
                b"\x89PNG\r\n\x1a\nnot-really-a-png", "image/png")

    def test_valid_photo_is_decoded_and_reencoded_without_metadata(self):
        raw = io.BytesIO()
        Image.new("RGB", (8, 6), "#fe5000").save(
            raw, format="JPEG", exif=b"Exif\x00\x00private-metadata")
        normalized = api_pg._style_library_normalize_photo(raw.getvalue(), "image/jpeg")
        with Image.open(io.BytesIO(normalized)) as image:
            self.assertEqual(image.size, (8, 6))
            self.assertFalse(image.getexif())

    def test_view_grants_and_creator_roles_are_separate(self):
        viewer = {"role": "retail", "allowed_pages": ["style-library"]}
        pd = {"role": "product_development", "allowed_pages": ["style-library"]}
        admin = {"role": "admin", "allowed_pages": []}
        self.assertTrue(api_pg._style_library_can_view(viewer))
        self.assertFalse(api_pg._style_library_can_create(viewer))
        self.assertTrue(api_pg._style_library_can_create(pd))
        self.assertTrue(api_pg._style_library_can_create(admin))

    def test_http_middleware_enforces_page_grant_and_preparse_size_limit(self):
        async def downstream(_request):
            return Response(status_code=204)

        denied = {
            "role": "retail", "status": "active", "allowed_pages": [],
        }
        granted = {
            "role": "retail", "status": "active",
            "allowed_pages": ["style-library"],
        }
        with mock.patch.object(api_pg, "_user_for_session", return_value=denied):
            response = asyncio.run(api_pg.clerk_auth_gate(
                self._request("/api/style-library/search"), downstream))
        self.assertEqual(response.status_code, 403)
        with mock.patch.object(api_pg, "_user_for_session", return_value=granted):
            response = asyncio.run(api_pg.clerk_auth_gate(
                self._request("/api/style-library/search"), downstream))
        self.assertEqual(response.status_code, 204)
        with mock.patch.object(api_pg, "_user_for_session", return_value={
            "role": "product_development", "status": "active",
            "allowed_pages": ["style-library"],
        }):
            response = asyncio.run(api_pg.clerk_auth_gate(
                self._request(
                    "/api/style-library", "POST",
                    api_pg.STYLE_LIBRARY_MAX_REQUEST_BYTES + 1),
                downstream))
        self.assertEqual(response.status_code, 413)

    def test_static_routes_precede_integer_detail_route(self):
        paths = [route.path for route in api_pg.app.routes]
        detail = paths.index("/api/style-library/{style_id}")
        self.assertLess(paths.index("/api/style-library/search"), detail)
        self.assertLess(paths.index("/api/style-library/image/{style_id}"), detail)

    def test_create_commits_durable_record_and_returns_grid_contract(self):
        row = {
            "id": 7,
            "style_name": "Aster Dress",
            "style_number": "AS-007",
            "category": "Dresses",
            "sub_category": "Maxi Dresses",
            "fabric": "Linen",
            "brand": "Vivo",
            "status": "Active",
            "launch_date": date(2026, 9, 1),
            "adoption_date": date(2026, 9, 2),
            "created_by": "pd-user",
            "created_at": datetime(2026, 9, 3, tzinfo=timezone.utc),
        }
        cursor = _Cursor(row=row)
        conn = _Connection(cursor)
        request = SimpleNamespace(
            state=SimpleNamespace(user={
                "id": "pd-user", "role": "product_development",
                "allowed_pages": ["style-library"],
            }))
        png = _png_bytes()
        with mock.patch.object(api_pg, "_ensure_style_library_table"), \
             mock.patch.object(api_pg, "get_conn", return_value=conn):
            result = asyncio.run(api_pg.create_style_library_style(
                request=request,
                style_name="Aster Dress",
                style_number="AS-007",
                category="Dresses",
                sub_category="Maxi Dresses",
                fabric="Linen",
                brand="Vivo",
                status="Active",
                launch_date="2026-09-01",
                adoption_date="2026-09-02",
                photo=_Upload(png),
            ))
        self.assertTrue(conn.committed)
        self.assertEqual(result["id"], 7)
        self.assertEqual(result["image_url"], "/api/style-library/image/7")
        insert_params = cursor.executed[-1][1]
        self.assertTrue(insert_params[9].adapted.startswith(b"\x89PNG\r\n\x1a\n"))
        with Image.open(io.BytesIO(insert_params[9].adapted)) as saved:
            self.assertEqual(saved.size, (2, 2))

    def test_duplicate_style_number_returns_conflict_and_rolls_back(self):
        cursor = _Cursor(raise_unique=True)
        conn = _Connection(cursor)
        request = SimpleNamespace(
            state=SimpleNamespace(user={
                "id": "pd-user", "role": "product_development",
                "allowed_pages": ["style-library"],
            }))
        with mock.patch.object(api_pg, "_ensure_style_library_table"), \
             mock.patch.object(api_pg, "get_conn", return_value=conn), \
             self.assertRaises(HTTPException) as raised:
            asyncio.run(api_pg.create_style_library_style(
                request=request,
                style_name="Aster Dress",
                style_number="AS-007",
                category="Dresses",
                sub_category="Maxi Dresses",
                fabric="Linen",
                brand="Vivo",
                status="Active",
                launch_date="",
                adoption_date="",
                photo=_Upload(_png_bytes()),
            ))
        self.assertEqual(raised.exception.status_code, 409)
        self.assertTrue(conn.rolled_back)

    def test_search_uses_filters_and_one_extra_row_for_pagination(self):
        rows = []
        for style_id in (4, 3):
            rows.append({
                "id": style_id,
                "style_name": f"Style {style_id}",
                "style_number": f"ST-{style_id}",
                "category": "Dresses",
                "sub_category": "Maxi Dresses",
                "fabric": "Linen",
                "brand": "Vivo",
                "status": "Active",
                "launch_date": None,
                "adoption_date": None,
            })
        cursor = _Cursor(rows=rows)
        with mock.patch.object(api_pg, "_ensure_style_library_table"), \
             mock.patch.object(api_pg, "get_conn", return_value=_Connection(cursor)):
            result = api_pg.search_style_library(
                q="Style", category="Dresses", sub_category="Maxi Dresses",
                fabric="Linen", brand="Vivo", status="Active", limit=1, offset=0)
        self.assertEqual([item["id"] for item in result["items"]], [4])
        self.assertTrue(result["has_more"])
        sql, params = cursor.executed[-1]
        self.assertIn("style_name ILIKE", sql)
        self.assertEqual(params[-2:], [2, 0])

    def test_image_endpoint_serves_saved_bytes_with_private_cache(self):
        cursor = _Cursor(image=(memoryview(b"image-bytes"), "image/webp"))
        with mock.patch.object(api_pg, "_ensure_style_library_table"), \
             mock.patch.object(api_pg, "get_conn", return_value=_Connection(cursor)):
            response = api_pg.get_style_library_image(4)
        self.assertEqual(response.body, b"image-bytes")
        self.assertEqual(response.media_type, "image/webp")
        self.assertIn(b"private", dict(response.raw_headers)[b"cache-control"])
        self.assertEqual(dict(response.raw_headers)[b"x-content-type-options"], b"nosniff")

    def test_frontend_registers_tab_form_cards_and_portal_detail(self):
        with open("artifacts/vivo-bi/src/pages/ProductAnalysis.jsx", encoding="utf-8") as handle:
            hub = handle.read()
        with open("artifacts/vivo-bi/src/pages/StyleLibrary.jsx", encoding="utf-8") as handle:
            page = handle.read()
        self.assertIn('pageId: "style-library"', hub)
        self.assertIn('data-testid="add-style-modal"', page)
        self.assertIn('api.post("/style-library", body)', page)
        self.assertIn("style-library-card-", page)
        self.assertIn("createPortal(", page)
        self.assertIn('data-testid="style-library-detail-modal"', page)


if __name__ == "__main__":
    import unittest
    unittest.main()