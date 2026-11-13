import type { Metadata } from 'next';
import { MotionIntro } from '@/components/invoicing-demo/MotionIntro';

export const metadata: Metadata = {
  title: 'Tendr motion intro',
  description: 'Intro motion graphic for the Tendr film.',
};

/** Intro plate. Later shots get their own /motion-* routes. The invoicing film stays at /invoicing-demo. */
export default function MotionIntroPage() {
  return <MotionIntro />;
}
