=== WP Membership Certificate Generator ===
Contributors: yourname
Tags: membership, certificate, woocommerce, pdf
Requires at least: 5.8
Tested up to: 6.5
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later

Automatically generate personalized membership certificates when users purchase a membership product via WooCommerce.

== Description ==

This plugin adds a complete membership certificate system to your WooCommerce store:

* **Auto-generates a unique Membership ID** (e.g. MEM-20260212-00042) when a user buys the membership product
* **Stores member data** — name, purchase date/time, membership ID — on the user profile
* **Creates a Member Dashboard page** with a beautiful certificate preview
* **One-click PDF download** — users click "Generate & Download Certificate" and get a high-quality PDF
* **Print support** — built-in print styles for direct printing
* **Admin settings page** — configure product ID, certificate title, organization name, signatory, and more
* **Users list column** — see Membership IDs directly in the WordPress Users table

== Installation ==

1. Upload the `wp-membership-certificate` folder to `/wp-content/plugins/`
2. Activate the plugin through the **Plugins** menu
3. Go to **Settings → Membership Certificate** and configure:
   - Your WooCommerce membership product ID (or leave blank to auto-detect)
   - Organization name, certificate title, signatory details
4. The plugin automatically creates a **"Member Dashboard"** page with the `[membership_dashboard]` shortcode
5. When a customer purchases the membership product and the order is completed, they receive a membership ID and can generate their certificate from the dashboard

== Shortcode ==

`[membership_dashboard]` — Place this on any page to display the member dashboard with certificate.

== Frequently Asked Questions ==

= How is the Membership ID generated? =
Format: `PREFIX-YYYYMMDD-NNNNN` where PREFIX is configurable (default: MEM), date is the purchase date, and NNNNN is an auto-incrementing counter.

= Can I customize the certificate design? =
Yes! Edit `assets/css/certificate.css` to change colors, fonts, layout, borders, etc. The HTML template is in `includes/shortcodes.php`.

= What if the user checks out as a guest? =
Guest checkouts are skipped. The user must be logged in / have an account for membership to be assigned.

== Changelog ==

= 1.0.0 =
* Initial release
