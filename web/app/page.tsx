'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Languages } from 'lucide-react';
import { TARGET_LANGUAGES } from '@/lib/languages';
import { useStoredValue } from '@/lib/useStoredValue';
import { Card, CardContent } from '@/components/ui/card';

const STORAGE_KEY = 'auto-translate-lite:language';

function LandingPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isReset = searchParams.get('reset') === '1';
  const storedLanguage = useStoredValue(STORAGE_KEY);

  useEffect(() => {
    if (storedLanguage === undefined) return;
    if (isReset) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else if (storedLanguage) {
      router.replace(`/view?lang=${storedLanguage}`);
    }
  }, [isReset, storedLanguage, router]);

  function selectLanguage(code: string) {
    window.localStorage.setItem(STORAGE_KEY, code);
    router.push(`/view?lang=${code}`);
  }

  const shouldShowGrid = storedLanguage !== undefined && (isReset || !storedLanguage);
  if (!shouldShowGrid) return null;

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-8 p-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Choose your language</h1>
        <p className="text-muted-foreground">Live captions for today&apos;s service</p>
      </div>
      <div className="grid grid-cols-2 gap-4 w-full max-w-md">
        {TARGET_LANGUAGES.map((language) => (
          <Card
            key={language.code}
            className="cursor-pointer transition-colors hover:ring-2 hover:ring-primary"
            onClick={() => selectLanguage(language.code)}
          >
            <CardContent className="flex min-h-24 flex-col items-center justify-center gap-2 p-4 text-center">
              <Languages className="size-5 text-muted-foreground" aria-hidden="true" />
              <span className="text-lg font-medium">{language.label}</span>
            </CardContent>
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
