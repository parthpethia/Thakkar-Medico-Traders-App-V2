<?php
/**
 * Admin settings page – WP Membership Certificate
 *
 * Settings → Membership Certificate
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

/* ── Register menu ────────────────────────── */
add_action( 'admin_menu', 'wmcert_admin_menu' );
function wmcert_admin_menu() {
    add_options_page(
        'Membership Certificate Settings',
        'Membership Certificate',
        'manage_options',
        'wmcert-settings',
        'wmcert_settings_page'
    );
}

/* ── Register settings ────────────────────── */
add_action( 'admin_init', 'wmcert_register_settings' );
function wmcert_register_settings() {
    $fields = array(
        'wmcert_membership_product_id' => 'sanitize_text_field',
        'wmcert_id_prefix'             => 'sanitize_text_field',
        'wmcert_certificate_title'     => 'sanitize_text_field',
        'wmcert_organization_name'     => 'sanitize_text_field',
        'wmcert_certificate_message'   => 'sanitize_textarea_field',
        'wmcert_signatory_name'        => 'sanitize_text_field',
        'wmcert_signatory_title'       => 'sanitize_text_field',
        'wmcert_dashboard_page_id'     => 'absint',
    );
    foreach ( $fields as $name => $sanitize ) {
        register_setting( 'wmcert_settings_group', $name, array( 'sanitize_callback' => $sanitize ) );
    }
}

/* ── Render settings page ─────────────────── */
function wmcert_settings_page() {
    ?>
    <div class="wrap">
        <h1>🎓 Membership Certificate Settings</h1>
        <form method="post" action="options.php">
            <?php
            settings_fields( 'wmcert_settings_group' );
            ?>
            <table class="form-table">

                <!-- Membership Product -->
                <tr>
                    <th scope="row"><label for="wmcert_membership_product_id">Membership Product ID</label></th>
                    <td>
                        <input type="number" id="wmcert_membership_product_id" name="wmcert_membership_product_id"
                               value="<?php echo esc_attr( get_option( 'wmcert_membership_product_id' ) ); ?>"
                               class="regular-text" min="0" />
                        <p class="description">
                            Enter the WooCommerce Product ID of your membership product.<br>
                            Leave empty to auto-detect any product with "membership" in its name.
                        </p>
                    </td>
                </tr>

                <!-- ID Prefix -->
                <tr>
                    <th scope="row"><label for="wmcert_id_prefix">Membership ID Prefix</label></th>
                    <td>
                        <input type="text" id="wmcert_id_prefix" name="wmcert_id_prefix"
                               value="<?php echo esc_attr( get_option( 'wmcert_id_prefix', 'MEM' ) ); ?>"
                               class="regular-text" maxlength="10" />
                        <p class="description">Prefix for generated IDs. Example: <code>MEM</code> → <code>MEM-20260212-00001</code></p>
                    </td>
                </tr>

                <!-- Certificate Title -->
                <tr>
                    <th scope="row"><label for="wmcert_certificate_title">Certificate Title</label></th>
                    <td>
                        <input type="text" id="wmcert_certificate_title" name="wmcert_certificate_title"
                               value="<?php echo esc_attr( get_option( 'wmcert_certificate_title', 'Certificate of Membership' ) ); ?>"
                               class="large-text" />
                    </td>
                </tr>

                <!-- Organization Name -->
                <tr>
                    <th scope="row"><label for="wmcert_organization_name">Organization Name</label></th>
                    <td>
                        <input type="text" id="wmcert_organization_name" name="wmcert_organization_name"
                               value="<?php echo esc_attr( get_option( 'wmcert_organization_name', get_bloginfo( 'name' ) ) ); ?>"
                               class="large-text" />
                        <p class="description">Displayed at the top of the certificate.</p>
                    </td>
                </tr>

                <!-- Certificate Message -->
                <tr>
                    <th scope="row"><label for="wmcert_certificate_message">Certificate Message</label></th>
                    <td>
                        <textarea id="wmcert_certificate_message" name="wmcert_certificate_message"
                                  rows="3" class="large-text"><?php echo esc_textarea( get_option( 'wmcert_certificate_message', 'This is to certify that the above-named person is a registered member of our organization.' ) ); ?></textarea>
                    </td>
                </tr>

                <!-- Signatory Name -->
                <tr>
                    <th scope="row"><label for="wmcert_signatory_name">Signatory Name</label></th>
                    <td>
                        <input type="text" id="wmcert_signatory_name" name="wmcert_signatory_name"
                               value="<?php echo esc_attr( get_option( 'wmcert_signatory_name' ) ); ?>"
                               class="regular-text" />
                        <p class="description">Name that appears in the signature line.</p>
                    </td>
                </tr>

                <!-- Signatory Title -->
                <tr>
                    <th scope="row"><label for="wmcert_signatory_title">Signatory Title</label></th>
                    <td>
                        <input type="text" id="wmcert_signatory_title" name="wmcert_signatory_title"
                               value="<?php echo esc_attr( get_option( 'wmcert_signatory_title', 'Director' ) ); ?>"
                               class="regular-text" />
                    </td>
                </tr>

                <!-- Dashboard Page -->
                <tr>
                    <th scope="row"><label for="wmcert_dashboard_page_id">Dashboard Page</label></th>
                    <td>
                        <?php
                        wp_dropdown_pages( array(
                            'name'             => 'wmcert_dashboard_page_id',
                            'id'               => 'wmcert_dashboard_page_id',
                            'selected'         => get_option( 'wmcert_dashboard_page_id' ),
                            'show_option_none' => '— Select a page —',
                            'option_none_value' => '',
                        ) );
                        ?>
                        <p class="description">The page containing the <code>[membership_dashboard]</code> shortcode. Created automatically on activation.</p>
                    </td>
                </tr>

            </table>
            <?php submit_button( 'Save Settings' ); ?>
        </form>

        <hr>
        <h2>Quick Stats</h2>
        <?php
        global $wpdb;
        $total_members = $wpdb->get_var(
            "SELECT COUNT(DISTINCT user_id) FROM {$wpdb->usermeta} WHERE meta_key = 'wmcert_membership_id'"
        );
        $latest_id = $wpdb->get_var(
            "SELECT meta_value FROM {$wpdb->usermeta} WHERE meta_key = 'wmcert_membership_id' ORDER BY umeta_id DESC LIMIT 1"
        );
        ?>
        <table class="widefat fixed" style="max-width:400px;">
            <tr><th>Total Members</th><td><strong><?php echo intval( $total_members ); ?></strong></td></tr>
            <tr><th>Latest Membership ID</th><td><code><?php echo esc_html( $latest_id ?: '—' ); ?></code></td></tr>
            <tr><th>ID Counter</th><td><?php echo intval( get_option( 'wmcert_id_counter', 0 ) ); ?></td></tr>
        </table>

    </div>
    <?php
}

/* ──────────────────────────────────────────────
 * Show Membership ID column in Users list
 * ────────────────────────────────────────────── */
add_filter( 'manage_users_columns', 'wmcert_users_column' );
function wmcert_users_column( $columns ) {
    $columns['wmcert_id'] = 'Membership ID';
    return $columns;
}

add_filter( 'manage_users_custom_column', 'wmcert_users_column_content', 10, 3 );
function wmcert_users_column_content( $value, $column_name, $user_id ) {
    if ( 'wmcert_id' === $column_name ) {
        $mid = get_user_meta( $user_id, 'wmcert_membership_id', true );
        return $mid ? '<code>' . esc_html( $mid ) . '</code>' : '—';
    }
    return $value;
}
