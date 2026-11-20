# Web E2E (Playwright)

```bash
npx playwright install chromium
E2E_BASE_URL=https://staging.example.com \
E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... \
E2E_STAFF_EMAIL=... E2E_STAFF_PASSWORD=... E2E_STAFF_NAME="Amit" \
E2E_STAFF2_EMAIL=... E2E_STAFF2_PASSWORD=... \
npm run test:e2e -w apps/web
```

Runs at 320, 390, 768, 1024 and 1440 px widths. Use synthetic users in a **staging** organization
whose admin MFA requirement is turned off (or automate a TOTP secret in your harness).
Never point E2E at production data.
