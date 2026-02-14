<?php
/**
 * Core membership helper functions.
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

/* ──────────────────────────────────────────────
 * Generate a unique Membership ID
 * Format:  PREFIX-YYYYMMDD-XXXXX  (e.g. MEM-20260212-00042)
 * ────────────────────────────────────────────── */
function wmcert_generate_membership_id( $user_id ) {
    $prefix  = get_option( 'wmcert_id_prefix', 'MEM' );

    // Get a running counter stored in options
    $counter = (int) get_option( 'wmcert_id_counter', 0 );
    $counter++;
    update_option( 'wmcert_id_counter', $counter );

    $membership_id = strtoupper( $prefix ) . '-' . date( 'Ymd' ) . '-' . str_pad( $counter, 5, '0', STR_PAD_LEFT );

    // Store on the user
    update_user_meta( $user_id, 'wmcert_membership_id', $membership_id );

    return $membership_id;
}

/* ──────────────────────────────────────────────
 * Save purchase date/time on user meta
 * ────────────────────────────────────────────── */
function wmcert_save_purchase_date( $user_id, $date = null ) {
    if ( null === $date ) {
        $date = current_time( 'mysql' );
    }
    update_user_meta( $user_id, 'wmcert_purchase_date', $date );
}

/* ──────────────────────────────────────────────
 * Get membership data for a user
 * ────────────────────────────────────────────── */
function wmcert_get_membership_data( $user_id ) {
    $user = get_userdata( $user_id );
    if ( ! $user ) {
        return false;
    }

    $membership_id = get_user_meta( $user_id, 'wmcert_membership_id', true );
    $purchase_date = get_user_meta( $user_id, 'wmcert_purchase_date', true );

    if ( ! $membership_id ) {
        return false;   // Not a member
    }

    return array(
        'user_id'        => $user_id,
        'full_name'      => $user->display_name ? $user->display_name : $user->first_name . ' ' . $user->last_name,
        'email'          => $user->user_email,
        'membership_id'  => $membership_id,
        'purchase_date'  => $purchase_date,
        'formatted_date' => $purchase_date ? date_i18n( get_option( 'date_format' ) . ' ' . get_option( 'time_format' ), strtotime( $purchase_date ) ) : '',
    );
}

/* ──────────────────────────────────────────────
 * Check if user is a member
 * ────────────────────────────────────────────── */
function wmcert_is_member( $user_id = 0 ) {
    if ( ! $user_id ) {
        $user_id = get_current_user_id();
    }
    return (bool) get_user_meta( $user_id, 'wmcert_membership_id', true );
}
