import { Page, Locator, expect } from '@playwright/test';

export class GatePage {
  readonly page: Page;
  readonly showSelect: Locator;
  readonly tokenInput: Locator;
  readonly scanButton: Locator;
  readonly cameraButton: Locator;
  readonly resultCard: Locator;
  readonly nextGuestButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.showSelect = page.locator('select');
    this.tokenInput = page.locator('form input');
    this.scanButton = page.locator('form button[type="submit"]');
    this.cameraButton = page.locator('button.btn--primary', { hasText: /camera|ক্যামেরা/i });
    this.resultCard = page.locator('.gate-result');
    this.nextGuestButton = page.locator('.gate-result button');
  }

  async goto() {
    await this.page.context().addCookies([
      { name: 'samatat-locale', value: 'en', domain: 'localhost', path: '/' },
    ]);
    await this.page.goto('/gate');
    await this.page.waitForLoadState('domcontentloaded');
  }

  async scanToken(token: string) {
    await this.tokenInput.fill(token);
    await this.scanButton.click();
  }

  async expectAdmitted() {
    await expect(this.resultCard).toHaveClass(/gate-result--ADMITTED/);
    await expect(this.resultCard).toContainText(/ADMITTED|প্রবেশ মঞ্জুর/i);
  }

  async expectDenied(reasonPattern?: RegExp) {
    await expect(this.resultCard).toHaveClass(/gate-result--DENIED/);
    if (reasonPattern) {
      await expect(this.resultCard).toContainText(reasonPattern);
    }
  }

  async clickNext() {
    await this.nextGuestButton.click();
  }
}
