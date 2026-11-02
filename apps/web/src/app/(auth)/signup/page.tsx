import { localMailEnabled } from '@/lib/local-mail-policy';
import SignupForm from './SignupForm';

export default function SignupPage() {
  return <SignupForm localMail={localMailEnabled(process.env)} />;
}
