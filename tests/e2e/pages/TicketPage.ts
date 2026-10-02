import { Page, Locator } from '@playwright/test';

export class TicketPage {
  readonly page: Page;
  readonly referenceText: Locator;
  readonly statusRow: Locator;
  readonly qrImage: Locator;
  readonly pdfDownloadLink: Locator;

  constructor(page: Page) {
    this.page = page;
    this.referenceText = page.locator('p[style*="monospace"]');
    this.statusRow = page.locator('div', { hasText: 'Status' });
    this.qrImage = page.locator('.ticket-pass img');
    this.pdfDownloadLink = page.locator('a[href*="/pdf"]');
  }

  async goto(bookingId: string) {
    await this.page.goto(`/tickets/${bookingId}`);
    await this.page.waitForLoadState('domcontentloaded');
  }
}
