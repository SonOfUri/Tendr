import type { Metadata } from 'next';
import { MotionConclusion } from '@/components/invoicing-demo/MotionConclusion';

export const metadata: Metadata = {
  title: 'Tendr motion conclusion',
  description: 'Conclusion motion graphic for the Tendr film.',
};

/** Closing plate. The intro stays at /motion-intro and the demo film at /motion-2. */
export default function MotionConclusionPage() {
  return <MotionConclusion />;
}
