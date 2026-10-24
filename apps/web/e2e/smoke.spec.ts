import { expect, test } from '@playwright/test';

test('landing page renders', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /One checkout/i })).toBeVisible();
});
