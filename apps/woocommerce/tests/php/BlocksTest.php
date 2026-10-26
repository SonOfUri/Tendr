<?php
/**
 * The Blocks checkout integration.
 *
 * @package Tendr
 */

use Automattic\WooCommerce\Blocks\Package;
use Automattic\WooCommerce\Blocks\Payments\PaymentMethodRegistry;

/**
 * Tendr_Blocks.
 */
class BlocksTest extends Tendr_Test_Case {

	public function test_payment_method_registered_with_blocks_integration(): void {
		$registry = Package::container()->get( PaymentMethodRegistry::class );
		$this->assertTrue( $registry->is_registered( 'tendr' ) );
		$method = $registry->get_registered( 'tendr' );
		$this->assertInstanceOf( Tendr_Blocks::class, $method );

		$this->assertSame( array( 'tendr-blocks' ), $method->get_payment_method_script_handles() );
		$this->assertTrue( wp_script_is( 'tendr-blocks', 'registered' ) );
		$deps = wp_scripts()->registered['tendr-blocks']->deps;
		$this->assertContains( 'wc-blocks-registry', $deps );
		$this->assertContains( 'wc-settings', $deps );

		$data = $method->get_payment_method_data();
		$this->assertSame( 'Pay with crypto', $data['title'] );
		$this->assertSame( array( 'products', 'refunds' ), $data['supports'] );
	}

	public function test_blocks_method_is_active_only_when_connected_and_enabled(): void {
		$method = new Tendr_Blocks();
		$method->initialize();
		$this->assertFalse( $method->is_active() );

		$issued = self::connect_locally();
		$method = new Tendr_Blocks();
		$method->initialize();
		$this->assertTrue( $method->is_active() );

		$encoded = (string) wp_json_encode( $method->get_payment_method_data() );
		foreach ( self::secrets_of( $issued ) as $secret ) {
			$this->assertStringNotContainsString( $secret, $encoded );
		}
		$this->assertStringNotContainsString( $issued['test']['publishable_key'], $encoded );
	}
}
