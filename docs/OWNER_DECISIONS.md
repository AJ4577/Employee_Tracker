# Decisions needed from the owner before real rollout

Safe defaults are in place for all of these; change them in Settings or config.

1. **Devices** — Android only first, or Android + iPhone? Company-managed or personal phones? (Affects MDM,
   battery-optimisation whitelisting, store distribution.)
2. **Tracking window & retention** — only during duty (current), whether the return trip is mandatory, and how long
   to keep raw GPS points (default 90 days).
3. **Scale** — number of staff, farmers, daily visits, admin viewers, GPS interval (default 45 s / 75 m). Drives the
   Supabase plan and map/geocoder plan.
4. **Existing data** — source of products/farmers/purchases (CSV, Zoho CRM, ERP)? Provide a sample; an import
   will be built after validating it. No live CRM will be modified without explicit details.
5. **Sign-in** — invitation sender address/domain (SMTP), whether SMS OTP is wanted (extra cost), MFA for staff.
6. **Route visibility** — who may view/export individual routes (default: all admins of the org).
7. **Geofence** — arrival radius (default 100 m), acceptable GPS exceptions, whether photo or delivery acknowledgement is required.
8. **Providers & accounts** (enter as secrets — never in this repo):
   * Supabase project(s): staging + production
   * Expo account + EAS project; Firebase (FCM V1 key); Apple Developer account (APNs)
   * Production map tiles (e.g. MapTiler, Stadia, Thunderforest, or self-hosted) and geocoder (e.g. LocationIQ,
     Google Geocoding, self-hosted Nominatim/Photon)
   * Web domain + hosting (e.g. Cloudflare Pages); app signing and store listings
9. **Legal** — employee location-monitoring notice and data-protection review by counsel.
