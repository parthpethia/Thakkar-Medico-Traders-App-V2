import { Redirect } from 'expo-router';

/** Default entry: login. Logged-in users are redirected from root _layout after session restore. */
export default function Index() {
  return <Redirect href="/(auth)/login" />;
}
