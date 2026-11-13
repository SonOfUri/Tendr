import type { Metadata } from 'next';
import { MotionDemo } from '@/components/invoicing-demo/MotionDemo';

export const metadata: Metadata = {
  title: 'Tendr motion demo',
  description: 'Scripted film of the Tendr live demo: use cases, checkout, Tendr AI, and customization.',
};

/** Scenes 02–07. The live playground at / stays interactive. */
export default function MotionDemoPage() {
  return <MotionDemo />;
}
