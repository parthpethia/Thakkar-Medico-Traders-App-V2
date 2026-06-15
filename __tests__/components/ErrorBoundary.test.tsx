import React from 'react';
import { Text } from 'react-native';
import { render } from '@testing-library/react-native';

// Import the actual ErrorBoundary component
import { ErrorBoundary } from '../../src/components/ErrorBoundary';

// Component that throws on demand
function Thrower({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('Test error from Thrower');
  }
  return <Text testID="child">Child content</Text>;
}

describe('ErrorBoundary', () => {
  // Suppress console.error for cleaner test output
  const originalConsoleError = console.error;
  beforeAll(() => {
    console.error = jest.fn();
  });
  afterAll(() => {
    console.error = originalConsoleError;
  });

  it('renders children when no error is thrown', () => {
    const { getByTestId } = render(
      <ErrorBoundary>
        <Thrower shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(getByTestId('child')).toBeTruthy();
  });

  it('renders fallback UI when child throws', () => {
    const { getByText, queryByTestId } = render(
      <ErrorBoundary>
        <Thrower shouldThrow={true} />
      </ErrorBoundary>,
    );

    // Child should not be rendered
    expect(queryByTestId('child')).toBeNull();

    // Fallback should show the error title
    expect(getByText('Something went wrong')).toBeTruthy();

    // Should show Try Again button
    expect(getByText('Try Again')).toBeTruthy();

    // Should show Go Home button
    expect(getByText('Go Home')).toBeTruthy();
  });

  it('shows error message in __DEV__ mode', () => {
    // In Jest, __DEV__ is true, so the ErrorBoundary DOES show the error message
    const { getByText } = render(
      <ErrorBoundary>
        <Thrower shouldThrow={true} />
      </ErrorBoundary>,
    );

    // The error message is displayed in dev mode for debugging
    expect(getByText('Test error from Thrower')).toBeTruthy();
  });
});
