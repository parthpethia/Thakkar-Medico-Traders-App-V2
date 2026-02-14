<?php
/**
 * AJAX handlers for front-end requests.
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

/* ──────────────────────────────────────────────
 * AJAX – Get certificate data (JSON)
 * Can be used for future enhancements (e.g. server-side PDF)
 * ────────────────────────────────────────────── */
add_action( 'wp_ajax_wmcert_get_certificate_data', 'wmcert_ajax_get_certificate_data' );
function wmcert_ajax_get_certificate_data() {
    check_ajax_referer( 'wmcert_nonce', 'nonce' );

    if ( ! is_user_logged_in() ) {
        wp_send_json_error( 'Not logged in.', 401 );
    }

    $data = wmcert_get_membership_data( get_current_user_id() );

    if ( ! $data ) {
        wp_send_json_error( 'No membership found.', 404 );
    }

    // Add settings
    $data['certificate_title']  = get_option( 'wmcert_certificate_title', 'Certificate of Membership' );
    $data['organization_name']  = get_option( 'wmcert_organization_name', get_bloginfo( 'name' ) );
    $data['certificate_message'] = get_option( 'wmcert_certificate_message', '' );
    $data['signatory_name']     = get_option( 'wmcert_signatory_name', '' );
    $data['signatory_title']    = get_option( 'wmcert_signatory_title', 'Director' );

    wp_send_json_success( $data );
}
