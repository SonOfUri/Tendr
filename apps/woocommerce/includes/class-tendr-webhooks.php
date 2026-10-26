<?php
/**
 * `POST /wp-json/tendr/v1/webhook`: tendr's signed payment updates.
 *
 * Public route; authenticity comes from the `Tendr-Signature` header alone
 * (`t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`, one `v1` per signing secret during a
 * rotation overlap). The MAC is checked over the raw request body before anything is decoded:
 * against both of the connection's webhook secrets, then the decoded `livemode` must name the mode
 * whose secret matched. 300 s tolerance either side. Every comparison is `hash_equals`.
 *
 * Each event is applied once: its id is claimed in `{prefix}tendr_events` (primary key) with an
 * atomic `INSERT IGNORE` before anything changes, marked done once the order change (or the
 * deliberate no-op) is saved, and released when the change could not be made (a 5xx, so tendr
 * retries). A claim left behind by a crashed request expires after CLAIM_TTL seconds.
 *
 * @package Tendr
 */

defined( 'ABSPATH' ) || exit;

/**
 * The webhook receiver.
 */
final class Tendr_Webhooks {

	const NAMESPACE = 'tendr/v1';
	const ROUTE     = '/webhook';

	/** Seconds a signature timestamp may be away from now, either way. */
	const TOLERANCE = 300;

	/** Seconds after which an unfinished claim may be taken over by a new delivery. */
	const CLAIM_TTL = 120;

	/** Days seen event ids are kept. */
	const RETENTION_DAYS = 30;

	const TABLE      = 'tendr_events';
	const DB_OPTION  = 'tendr_events_db';
	const DB_VERSION = '1';
	const PRUNE_HOOK = 'tendr_prune_events';

	const STATE_CLAIMED = 0;
	const STATE_DONE    = 1;

	/**
	 * Hook the route and the daily prune.
	 */
	public static function register(): void {
		add_action( 'rest_api_init', array( self::class, 'register_routes' ) );
		add_action( self::PRUNE_HOOK, array( self::class, 'prune' ) );
		// A plugin updated without re-activation still gets its schedule.
		add_action( 'init', array( self::class, 'schedule' ) );
	}

	/**
	 * `rest_api_init`.
	 */
	public static function register_routes(): void {
		register_rest_route(
			self::NAMESPACE,
			self::ROUTE,
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( self::class, 'handle' ),
				// Public: the Tendr-Signature header authenticates the request (checked in handle()).
				'permission_callback' => '__return_true',
			)
		);
	}

	// ------------------------------------------------------------------ lifecycle.

	/**
	 * Activation: the events table and the daily prune.
	 */
	public static function activate(): void {
		self::install();
		self::schedule();
	}

	/**
	 * Deactivation: stop the prune (the table stays until uninstall).
	 */
	public static function deactivate(): void {
		wp_clear_scheduled_hook( self::PRUNE_HOOK );
	}

	/**
	 * Schedule the daily prune when it is not.
	 */
	public static function schedule(): void {
		if ( false === wp_next_scheduled( self::PRUNE_HOOK ) ) {
			wp_schedule_event( time() + HOUR_IN_SECONDS, 'daily', self::PRUNE_HOOK );
		}
	}

	/**
	 * `{prefix}tendr_events`.
	 */
	public static function table(): string {
		global $wpdb;
		return $wpdb->prefix . self::TABLE;
	}

	/**
	 * Create (or update) the events table.
	 */
	public static function install(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$table   = self::table();
		$charset = $wpdb->get_charset_collate();
		dbDelta(
			"CREATE TABLE {$table} (
  event_id varchar(64) NOT NULL,
  received_at datetime NOT NULL,
  state tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY  (event_id),
  KEY received_at (received_at)
) {$charset};"
		);
		update_option( self::DB_OPTION, self::DB_VERSION, false );
	}

	/**
	 * Create the table when this version has not yet (a plugin updated without re-activation).
	 */
	public static function ensure_table(): void {
		if ( self::DB_VERSION !== get_option( self::DB_OPTION ) ) {
			self::install();
		}
	}

	/**
	 * Daily: forget event ids older than RETENTION_DAYS.
	 */
	public static function prune(): void {
		global $wpdb;
		$table    = self::table();
		$suppress = $wpdb->suppress_errors();
		$wpdb->query( // phpcs:ignore WordPress.DB.DirectDatabaseQuery -- a plugin-owned log table, not cacheable.
			$wpdb->prepare(
				"DELETE FROM {$table} WHERE received_at < %s", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- table name from $wpdb->prefix.
				gmdate( 'Y-m-d H:i:s', time() - self::RETENTION_DAYS * DAY_IN_SECONDS )
			)
		);
		$wpdb->suppress_errors( $suppress );
	}

	/**
	 * Uninstall: drop the table, its version and the schedule.
	 */
	public static function uninstall(): void {
		global $wpdb;
		$wpdb->query( 'DROP TABLE IF EXISTS ' . self::table() ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL.NotPrepared, WordPress.DB.DirectDatabaseQuery.SchemaChange -- the plugin's own table, removed on uninstall.
		delete_option( self::DB_OPTION );
		wp_clear_scheduled_hook( self::PRUNE_HOOK );
	}

	// ------------------------------------------------------------------ the request.

	/**
	 * Verify, de-duplicate and apply one event.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function handle( WP_REST_Request $request ) {
		$body  = (string) $request->get_body();
		$event = self::verify( (string) $request->get_header( 'tendr_signature' ), $body, time() );
		if ( is_wp_error( $event ) ) {
			return $event;
		}

		if ( ! Tendr_Order_Sync::handles( $event['type'] ) ) {
			// `ping` and anything this plugin does not act on: acknowledged, nothing to remember.
			return self::ok();
		}

		$claim = self::claim( $event['id'] );
		if ( 'done' === $claim ) {
			return self::ok();
		}
		if ( 'busy' === $claim ) {
			return new WP_Error( 'tendr_event_in_progress', __( 'Already being processed.', 'tendr' ), array( 'status' => 409 ) );
		}
		if ( 'error' === $claim ) {
			return self::retry();
		}

		$result = Tendr_Order_Sync::process( $event );
		if ( is_wp_error( $result ) ) {
			self::release( $event['id'] );
			return self::retry();
		}
		self::finish( $event['id'] );
		return self::ok();
	}

	/**
	 * The authentic event, or a 400. Nothing is decoded until a secret's MAC matches the raw body.
	 *
	 * @param string $header Tendr-Signature.
	 * @param string $body   Raw request body.
	 * @param int    $now    Unix time.
	 * @return array|WP_Error `{id, type, created, livemode, data}`.
	 */
	public static function verify( string $header, string $body, int $now ) {
		$parsed = self::parse_header( $header );
		if ( null === $parsed ) {
			return self::bad_request();
		}

		// Which mode's secret signed this body. Every candidate is compared (no early exit).
		$matched = array();
		foreach ( Tendr_Credentials::MODES as $mode ) {
			$credentials = Tendr_Credentials::get( $mode );
			if ( null === $credentials || '' === (string) $credentials['webhook_secret'] ) {
				continue;
			}
			$expected = hash_hmac( 'sha256', $parsed['t'] . '.' . $body, (string) $credentials['webhook_secret'] );
			$ok       = false;
			foreach ( $parsed['v1'] as $candidate ) {
				$ok = hash_equals( $expected, $candidate ) || $ok;
			}
			if ( $ok ) {
				$matched[] = $mode;
			}
		}
		if ( array() === $matched || abs( $now - $parsed['t'] ) > self::TOLERANCE ) {
			return self::bad_request();
		}

		$event = json_decode( $body, true );
		if (
			! is_array( $event )
			|| ! isset( $event['id'], $event['type'], $event['livemode'], $event['data'] )
			|| ! is_string( $event['id'] ) || ! preg_match( '/^[A-Za-z0-9_]{1,64}$/', $event['id'] )
			|| ! is_string( $event['type'] ) || ! preg_match( '/^[a-z][a-z0-9_.]{0,63}$/', $event['type'] )
			|| ! is_bool( $event['livemode'] )
			|| ! is_array( $event['data'] )
		) {
			return self::bad_request();
		}
		// The event's own mode decides which secret had to sign it.
		if ( ! in_array( $event['livemode'] ? 'live' : 'test', $matched, true ) ) {
			return self::bad_request();
		}
		return $event;
	}

	/**
	 * `t=<t>,v1=<hex>[,v1=<hex>…]` as the API writes it (canonical `t`, lowercase 64-hex `v1`,
	 * unknown keys ignored), or null when missing or malformed.
	 *
	 * @param string $header Header value.
	 * @return array{t: int, v1: string[]}|null
	 */
	public static function parse_header( string $header ): ?array {
		$t  = null;
		$v1 = array();
		foreach ( explode( ',', $header ) as $part ) {
			$item = trim( $part );
			if ( '' === $item ) {
				continue;
			}
			$eq = strpos( $item, '=' );
			if ( false === $eq || 0 === $eq ) {
				return null;
			}
			$key   = trim( substr( $item, 0, $eq ) );
			$value = trim( substr( $item, $eq + 1 ) );
			if ( 't' === $key ) {
				if ( null !== $t || ! preg_match( '/^(0|[1-9][0-9]{0,11})$/', $value ) ) {
					return null;
				}
				$t = (int) $value;
			} elseif ( 'v1' === $key ) {
				if ( ! preg_match( '/^[0-9a-f]{64}$/', $value ) ) {
					return null;
				}
				$v1[] = $value;
			}
		}//end foreach
		return ( null === $t || array() === $v1 ) ? null : array(
			't'  => $t,
			'v1' => $v1,
		);
	}

	// ------------------------------------------------------------------ claims.

	/**
	 * Claim an event id: 'new' (this request applies it), 'done' (already applied), 'busy'
	 * (another delivery is applying it right now) or 'error' (the table cannot be written).
	 *
	 * @param string $event_id Event id.
	 */
	public static function claim( string $event_id ): string {
		self::ensure_table();
		$inserted = self::insert_claim( $event_id );
		if ( null === $inserted ) {
			// The table went missing (dropped, or an update skipped activation): create it once.
			self::install();
			$inserted = self::insert_claim( $event_id );
		}
		if ( null === $inserted ) {
			return 'error';
		}
		if ( $inserted ) {
			return 'new';
		}

		global $wpdb;
		$table = self::table();
		$state = $wpdb->get_var( $wpdb->prepare( "SELECT state FROM {$table} WHERE event_id = %s", $event_id ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- plugin table; must not be cached.
		if ( null === $state ) {
			// Released between the insert and this read; tendr retries.
			return 'busy';
		}
		if ( self::STATE_DONE === (int) $state ) {
			return 'done';
		}
		// A claim older than CLAIM_TTL belongs to a request that died: take it over atomically.
		$taken = $wpdb->query( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$wpdb->prepare(
				"UPDATE {$table} SET received_at = %s WHERE event_id = %s AND state = %d AND received_at < %s", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				gmdate( 'Y-m-d H:i:s' ),
				$event_id,
				self::STATE_CLAIMED,
				gmdate( 'Y-m-d H:i:s', time() - self::CLAIM_TTL )
			)
		);
		return 1 === $taken ? 'new' : 'busy';
	}

	/**
	 * `INSERT IGNORE` the claim: true when this request inserted it, false when the id exists,
	 * null on a database error.
	 *
	 * @param string $event_id Event id.
	 */
	private static function insert_claim( string $event_id ): ?bool {
		global $wpdb;
		$table    = self::table();
		$suppress = $wpdb->suppress_errors();
		$rows     = $wpdb->query( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$wpdb->prepare(
				"INSERT IGNORE INTO {$table} (event_id, received_at, state) VALUES (%s, %s, %d)", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$event_id,
				gmdate( 'Y-m-d H:i:s' ),
				self::STATE_CLAIMED
			)
		);
		$wpdb->suppress_errors( $suppress );
		if ( false === $rows ) {
			return null;
		}
		return 1 === (int) $rows;
	}

	/**
	 * The event was applied (or deliberately ignored): remember it.
	 *
	 * @param string $event_id Event id.
	 */
	private static function finish( string $event_id ): void {
		global $wpdb;
		$wpdb->update( self::table(), array( 'state' => self::STATE_DONE ), array( 'event_id' => $event_id ), array( '%d' ), array( '%s' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
	}

	/**
	 * The event could not be applied: forget the claim so tendr's retry is processed.
	 *
	 * @param string $event_id Event id.
	 */
	private static function release( string $event_id ): void {
		global $wpdb;
		$wpdb->delete( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			self::table(),
			array(
				'event_id' => $event_id,
				'state'    => self::STATE_CLAIMED,
			),
			array( '%s', '%d' )
		);
	}

	// ------------------------------------------------------------------ responses.

	/**
	 * 200 `{"received":true}`.
	 */
	private static function ok(): WP_REST_Response {
		return new WP_REST_Response( array( 'received' => true ), 200 );
	}

	/**
	 * 400 for anything not authentic or not an event.
	 */
	private static function bad_request(): WP_Error {
		return new WP_Error( 'tendr_bad_signature', __( 'Invalid signature.', 'tendr' ), array( 'status' => 400 ) );
	}

	/**
	 * 503: try again later.
	 */
	private static function retry(): WP_Error {
		return new WP_Error( 'tendr_retry', __( 'Try again later.', 'tendr' ), array( 'status' => 503 ) );
	}
}
