<?php
/**
 * WooCommerce integration hooks.
 *
 * Listens for completed orders that contain the configured membership product
 * and assigns a membership ID + purchase date to the buyer.
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

/* ──────────────────────────────────────────────
 * On order status → completed / processing
 * ────────────────────────────────────────────── */
add_action( 'woocommerce_order_status_completed',  'wmcert_handle_order_complete' );
add_action( 'woocommerce_order_status_processing', 'wmcert_handle_order_complete' );

function wmcert_handle_order_complete( $order_id ) {
    $order   = wc_get_order( $order_id );
    $user_id = $order->get_user_id();

    if ( ! $user_id ) {
        return; // Guest checkout – skip
    }

    // Already a member? Don't overwrite
    if ( wmcert_is_member( $user_id ) ) {
        return;
    }

    $target_product_id = (int) get_option( 'wmcert_membership_product_id', 0 );

    foreach ( $order->get_items() as $item ) {
        $product_id = $item->get_product_id();

        // Match by specific product ID **or** by product name containing "membership"
        $is_match = false;

        if ( $target_product_id && $product_id === $target_product_id ) {
            $is_match = true;
        }

        if ( ! $target_product_id ) {
            // Fallback: match any product whose name contains "membership"
            $product_name = strtolower( $item->get_name() );
            if ( false !== strpos( $product_name, 'membership' ) ) {
                $is_match = true;
            }
        }

        if ( $is_match ) {
            // Generate membership ID
            wmcert_generate_membership_id( $user_id );

            // Save purchase date from order
            $order_date = $order->get_date_completed()
                ? $order->get_date_completed()->date( 'Y-m-d H:i:s' )
                : $order->get_date_created()->date( 'Y-m-d H:i:s' );
            wmcert_save_purchase_date( $user_id, $order_date );

            // Mark the order so we don't double-process
            $order->update_meta_data( '_wmcert_processed', 'yes' );
            $order->save();

            break; // One membership per order is enough
        }
    }
}

/* ──────────────────────────────────────────────
 * Redirect to member dashboard after purchase
 * ────────────────────────────────────────────── */
add_action( 'woocommerce_thankyou', 'wmcert_maybe_redirect_to_dashboard', 10, 1 );
function wmcert_maybe_redirect_to_dashboard( $order_id ) {
    $order   = wc_get_order( $order_id );
    $user_id = $order ? $order->get_user_id() : 0;

    if ( ! $user_id || ! wmcert_is_member( $user_id ) ) {
        return;
    }

    $page_id = get_option( 'wmcert_dashboard_page_id' );
    if ( ! $page_id ) {
        return;
    }

    $dashboard_url = get_permalink( $page_id );
    if ( $dashboard_url ) {
        // Output a JS redirect so WooCommerce analytics/tracking scripts can still fire
        ?>
        <script>
            setTimeout(function(){
                window.location.href = '<?php echo esc_url( $dashboard_url ); ?>';
            }, 3000); // 3-second delay so user sees "Thank you" briefly
        </script>
        <p style="text-align:center;margin-top:20px;">
            🎉 <strong>Welcome, new member!</strong>
            You will be redirected to your <a href="<?php echo esc_url( $dashboard_url ); ?>">Member Dashboard</a> in a few seconds…
        </p>
        <?php
    }
}
