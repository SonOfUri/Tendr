import { expect, test } from '@playwright/test';
import { blockExternal } from './support/network';

test.beforeEach(async ({ context }) => {
  await blockExternal(context);
});

test('landing page renders', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /One checkout/i })).toBeVisible();
});
