'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { TARGET_LANGUAGES } from '@/lib/languages';
import { Card, CardContent } from '@/components/ui/card';

const STORAGE_KEY = 'auto-translate-lite:language';

function LandingPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (searchParams.get('reset') === '1') {
      window.localStorage.removeItem(STORAGE_KEY);
      setReady(true);
      return;
    }
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) {
      router.replace(`/view?lang=${saved}`);
    } else {
      setReady(true);
    }
  }, [router, searchParams]);

  function selectLanguage(code: string) {
    window.localStorage.setItem(STORAGE_KEY, code);
    router.push(`/view?lang=${code}`);
  }

  if (!ready) return null;

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold text-center">Choose your language</h1>
      <div className="grid grid-cols-2 gap-4 w-full max-w-md">
        {TARGET_LANGUAGES.map((language) => (
          <Card
            key={language.code}
            className="cursor-pointer hover:bg-accent transition-colors"
            onClick={() => selectLanguage(language.code)}
          >
            <CardContent className="p-4 text-center text-lg">{language.label}</CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}

export default function LandingPage() {
  return (
    <Suspense fallback={null}>
      <LandingPageContent />
    </Suspense>
  );
}
