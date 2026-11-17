import os
import json
import socket
import subprocess
import time
import unittest
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        cls.url = f"http://127.0.0.1:{port}"
        cls.server = subprocess.Popen(
            ["node", "scripts/browser-server.js"], cwd=ROOT,
            env={**os.environ, "BROWSER_TEST_PORT": str(port)},
            stdout=subprocess.DEVNULL,
        )
        for _ in range(100):
            try:
                with urlopen(cls.url + "/health", timeout=1) as response:
                    if response.status == 200:
                        break
            except OSError:
                time.sleep(0.05)
        else:
            cls.server.terminate()
            cls.server.wait(timeout=10)
            raise RuntimeError("Browser fixture server did not start")
        cls.playwright = sync_playwright().start()
        try:
            cls.browser = cls.playwright.chromium.launch(headless=True)
        except Exception:
            cls.server.terminate()
            cls.server.wait(timeout=10)
            cls.playwright.stop()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.terminate()
        cls.server.wait(timeout=10)

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 390, "height": 844})
        self.page = self.context.new_page()
        self.page.goto(self.url)
        self.page.wait_for_load_state("networkidle")

    def tearDown(self):
        self.context.close()

    def sign_in(self):
        self.page.get_by_label("Username", exact=True).fill("test-user")
        self.page.get_by_label("Password", exact=True).fill("test-only-high-entropy-password")
        with self.page.expect_navigation(wait_until="networkidle"):
            self.page.get_by_role("button", name="Enter the lab").click()
        expect(self.page.locator("#decide-button")).to_be_enabled()

    def test_decision_map_is_responsive_and_requires_no_inference(self):
        requests = []
        self.page.on("request", lambda request: requests.append(request.url) if "/api/decide" in request.url else None)
        self.sign_in()
        diagram = self.page.locator(".flow-section")
        for width in (390, 1280):
            self.page.set_viewport_size({"width": width, "height": 844})
            expect(diagram.get_by_role("heading", name="One ticket, multiple paths.")).to_be_visible()
            expect(diagram.locator(".flow-answer")).to_have_count(3)
            expect(diagram.locator(".flow-path")).to_have_count(3)
            self.assertTrue(self.page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
        self.page.emulate_media(reduced_motion="reduce")
        self.assertEqual(diagram.locator(".flow-path").first.evaluate(
            "(element) => getComputedStyle(element).animationName"), "none")
        self.assertEqual(requests, [])

    def test_login_logout_mobile_and_session_expiry(self):
        self.assertTrue(self.page.url.endswith("/login"))
        self.assertTrue(self.page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
        self.page.get_by_label("Username", exact=True).fill("wrong")
        self.page.get_by_label("Password", exact=True).fill("wrong")
        self.page.get_by_role("button", name="Show password", exact=True).click()
        expect(self.page.locator("#password")).to_have_attribute("type", "text")
        with self.page.expect_navigation(wait_until="networkidle"):
            self.page.get_by_role("button", name="Enter the lab").click()
        expect(self.page.get_by_role("alert")).to_contain_text("Invalid username or password")
        self.sign_in()
        with self.page.expect_navigation(wait_until="networkidle"):
            self.page.get_by_role("button", name="Sign out", exact=True).click()
        self.assertTrue(self.page.url.endswith("/login"))
        self.sign_in()
        self.context.clear_cookies()
        self.page.locator("#decide-button").click()
        self.page.wait_for_url(self.url + "/login")

    def test_policy_comparison_and_evaluation(self):
        self.sign_in()
        self.page.locator("#decide-button").click()
        expect(self.page.locator("#results")).to_be_visible()
        self.page.locator("#review-threshold").fill("100")
        expect(self.page.locator("#action")).to_have_text("Human review")
        self.page.locator("#ticket").fill("New synthetic ticket")
        expect(self.page.locator("#results")).to_be_hidden()
        self.page.locator("#paraphrase").fill("A different synthetic wording")
        self.page.locator("#comparison-button").click()
        expect(self.page.locator("#comparison-body tr")).to_have_count(3)
        self.page.locator("#benchmark-button").click()
        expect(self.page.locator("#benchmark-status")).to_contain_text("Completed: 6 / 6", timeout=15000)
        expect(self.page.locator("#evaluation-summary")).to_contain_text('"confusion"')
        self.page.locator("#evaluation-mode").select_option("extended")
        self.page.locator("#benchmark-button").click()
        expect(self.page.locator("#benchmark-status")).to_contain_text("Completed: 18 / 18", timeout=15000)

    def test_foundry_selection_is_used_for_decisions_evaluation_and_comparison(self):
        projects = [
            {"id": "project-a", "name": "Project A", "account": "Account A", "endpoint": "https://fixture.cognitiveservices.azure.com"},
            {"id": "project-b", "name": "Project B", "account": "Account B", "endpoint": "https://other.cognitiveservices.azure.com"},
        ]

        def configuration(route):
            response = route.fetch()
            body = response.json()
            body["foundryDiscoveryEnabled"] = True
            route.fulfill(response=response, json=body)

        self.page.route("**/api/config", configuration)
        self.page.route("**/api/foundry/projects", lambda route: route.fulfill(
            json={"projects": projects, "subscriptionId": "fixture"}))
        self.page.route("**/api/foundry/models?*", lambda route: route.fulfill(
            json={"models": [{"id": "decision-a", "model": "Microsoft-Decision-1"},
                             {"id": "decision-b", "model": "Microsoft-Decision-1"}]}))
        self.sign_in()
        expect(self.page.locator("#foundry-controls")).to_be_visible()
        self.page.locator("#foundry-project").select_option("project-b")
        expect(self.page.locator("#foundry-model")).to_be_enabled()
        self.page.locator("#foundry-model").select_option("decision-b")
        expect(self.page.locator("#request-json")).to_contain_text('"model": "decision-b"')
        sent = []

        def inference(route):
            body = json.loads(route.request.post_data)
            sent.append(body)
            # The deterministic inference fixture has no discovery catalog.
            route.continue_(post_data=json.dumps({key: value for key, value in body.items()
                                                 if key not in ("projectId", "deployment")}))

        self.page.route("**/api/decide", inference)
        self.page.locator("#decide-button").click()
        expect(self.page.locator("#results")).to_be_visible()
        self.page.locator("#benchmark-button").click()
        expect(self.page.locator("#benchmark-status")).to_contain_text("Completed: 6 / 6", timeout=15000)
        self.page.locator("#paraphrase").fill("Synthetic paraphrase")
        self.page.locator("#comparison-button").click()
        expect(self.page.locator("#comparison-body tr")).to_have_count(3)
        self.assertEqual(len(sent), 10)
        self.assertTrue(all(item["projectId"] == "project-b" and item["deployment"] == "decision-b" for item in sent))
        self.page.locator("#foundry-model").select_option("")
        expect(self.page.locator("#decide-button")).to_be_disabled()
        expect(self.page.locator("#foundry-model")).to_be_enabled()
        self.page.locator("#foundry-model").select_option("decision-a")
        expect(self.page.locator("#decide-button")).to_be_enabled()
        expect(self.page.locator("#results")).to_be_hidden()
        self.assertTrue(self.page.evaluate("document.documentElement.scrollWidth <= innerWidth"))

    def test_foundry_discovery_failure_can_be_retried(self):
        def configuration(route):
            response = route.fetch()
            route.fulfill(response=response, json={**response.json(), "foundryDiscoveryEnabled": True})

        self.page.route("**/api/config", configuration)
        self.page.route("**/api/foundry/projects", lambda route: route.fulfill(
            status=401, json={"error": "Run az login"}))
        self.page.get_by_label("Username", exact=True).fill("test-user")
        self.page.get_by_label("Password", exact=True).fill("test-only-high-entropy-password")
        with self.page.expect_navigation(wait_until="networkidle"):
            self.page.get_by_role("button", name="Enter the lab").click()
        expect(self.page.locator("#error")).to_contain_text("Run az login")
        expect(self.page.locator("#decide-button")).to_be_disabled()
        expect(self.page.locator("#reload-foundry")).to_be_enabled()
        self.page.unroute("**/api/foundry/projects")
        self.page.route("**/api/foundry/projects", lambda route: route.fulfill(
            json={"projects": [], "subscriptionId": "fixture"}))
        self.page.locator("#reload-foundry").click()
        expect(self.page.locator("#foundry-status")).to_contain_text("No Foundry projects")
        expect(self.page.locator("#error")).to_be_hidden()
    def test_cancel_waiting_run(self):
        self.sign_in()
        self.page.locator("#ticket").fill("Slow fixture")
        self.page.locator("#decide-button").click()
        expect(self.page.locator("#cancel-button")).to_be_visible()
        self.page.locator("#cancel-button").click()
        expect(self.page.locator("#decide-button")).to_be_enabled()
        expect(self.page.locator("#error")).to_contain_text("Cancelled")


if __name__ == "__main__":
    unittest.main()
