import { Redirect } from 'expo-router';
import React from 'react';

/** Root route → the daily log tab. */
export default function Index() {
  return <Redirect href="/log" />;
}
