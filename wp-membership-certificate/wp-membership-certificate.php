<?php
/**
 * Plugin Name: WP Membership Certificate Generator
 * Plugin URI:  https://yoursite.com
 * Description: Automatically generates membership certificates with unique ID, name, and purchase date when users buy a membership product via WooCommerce.
 * Version:     1.0.0
 * Author:      Your Name
 * Author URI:  https://yoursite.com
 * License:     GPL-2.0+
 * Text Domain: wp-membership-cert
 * Requires Plugins: woocommerce
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

/* ──────────────────────────────────────────────
 * Constants
 * ────────────────────────────────────────────── */
define( 'WMCERT_VERSION', '1.0.0' );
define( 'WMCERT_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'WMCERT_PLUGIN_URL', plugin_dir_url( __FILE__ ) );

/* ──────────────────────────────────────────────
 * Include sub-files
 * ────────────────────────────────────────────── */
require_once WMCERT_PLUGIN_DIR . 'includes/membership-functions.php';
require_once WMCERT_PLUGIN_DIR . 'includes/woocommerce-hooks.php';
require_once WMCERT_PLUGIN_DIR . 'includes/shortcodes.php';
require_once WMCERT_PLUGIN_DIR . 'includes/ajax-handlers.php';
require_once WMCERT_PLUGIN_DIR . 'includes/admin-settings.php';

/* ──────────────────────────────────────────────
 * Activation – create default options
 * ────────────────────────────────────────────── */
register_activation_hook( __FILE__, 'wmcert_activate' );
function wmcert_activate() {
    // Default options
    $defaults = array(
        'membership_product_id'   => '',
        'id_prefix'               => 'MEM',
        'certificate_title'       => 'Certificate of Membership',
        'organization_name'       => get_bloginfo( 'name' ),
        'certificate_message'     => 'This is to certify that the above-named person is a registered member of our organization.',
        'signatory_name'          => '',
        'signatory_title'         => 'Director',
        'dashboard_page_id'       => '',
    );
    foreach ( $defaults as $key => $value ) {
        if ( false === get_option( 'wmcert_' . $key ) ) {
            add_option( 'wmcert_' . $key, $value );
        }
    }

    // Auto-create the dashboard page if it doesn't exist
    if ( ! get_option( 'wmcert_dashboard_page_id' ) ) {
        $page_id = wp_insert_post( array(
            'post_title'   => 'Member Dashboard',
            'post_content' => '[membership_dashboard]',
            'post_status'  => 'publish',
            'post_type'    => 'page',
        ) );
        if ( $page_id && ! is_wp_error( $page_id ) ) {
            update_option( 'wmcert_dashboard_page_id', $page_id );
        }
    }
}

/* ──────────────────────────────────────────────
 * Enqueue front-end assets
 * ────────────────────────────────────────────── */
add_action( 'wp_enqueue_scripts', 'wmcert_enqueue_assets' );
function wmcert_enqueue_assets() {
    // Only load on pages that use the shortcode
    global $post;
    if ( is_a( $post, 'WP_Post' ) && has_shortcode( $post->post_content, 'membership_dashboard' ) ) {

        // html2canvas
        wp_enqueue_script(
            'html2canvas',
            'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
            array(),
            '1.4.1',
            true
        );

        // jsPDF
        wp_enqueue_script(
            'jspdf',
            'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
            array(),
            '2.5.1',
            true
        );

        // Plugin JS
        wp_enqueue_script(
            'wmcert-front',
            WMCERT_PLUGIN_URL . 'assets/js/certificate.js',
            array( 'jquery', 'html2canvas', 'jspdf' ),
            WMCERT_VERSION,
            true
        );

        wp_localize_script( 'wmcert-front', 'wmcert_ajax', array(
            'ajax_url' => admin_url( 'admin-ajax.php' ),
            'nonce'    => wp_create_nonce( 'wmcert_nonce' ),
        ) );

        // Plugin CSS
        wp_enqueue_style(
            'wmcert-front',
            WMCERT_PLUGIN_URL . 'assets/css/certificate.css',
            array(),
            WMCERT_VERSION
        );
    }
}
