import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';
import { Feather } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Linking as RNLinking,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import WebView, {
  WebViewMessageEvent,
  WebViewNavigation,
} from 'react-native-webview';
import colors from '@/constants/colors';

const TOKEN_KEY = 'vivo_community_token';
const NOTIF_PROMPT_DISMISSED_KEY = 'notif_prompt_dismissed';
const NOTIF_OS_PERMISSION_KEY = 'notif_os_permission';
const PRODUCTION_COMMUNITY_URL = 'https://vivofashionbrands.com/app/';
// A store bundle must never redirect its credential bridge to an environment
// variable. Overrides are accepted only in a development build.
const COMMUNITY_URL = __DEV__
  ? process.env.EXPO_PUBLIC_COMMUNITY_URL ||
    (process.env.EXPO_PUBLIC_DOMAIN
      ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/app/`
      : PRODUCTION_COMMUNITY_URL)
  : PRODUCTION_COMMUNITY_URL;
const COMMUNITY_ORIGIN = new URL(COMMUNITY_URL).origin;
type NotificationPermissionState = 'granted' | 'denied' | null;
type NotificationPromptMode = 'initial' | 'contextual' | 'settings';

interface StoredNotificationState {
  dismissed: boolean;
  osPermission: NotificationPermissionState;
}

const INJECTED_BOOT = `
  (function () {
    window.__VIVO_NATIVE_APP__ = true;
    window.__VIVO_NATIVE_APP_VERSION__ = "1.0.0";
    var post = function (message) {
      try { window.ReactNativeWebView.postMessage(JSON.stringify(message)); } catch (_) {}
    };
    if (!navigator.share) {
      navigator.share = function (data) {
        post({ type: "share", title: data && data.title, text: data && data.text, url: data && data.url });
        return Promise.resolve();
      };
    }
    if (!navigator.clipboard) {
      navigator.clipboard = {
        writeText: function (text) {
          post({ type: "clipboard", text: String(text || "") });
          return Promise.resolve();
        }
      };
    }
  })();
  true;
`;

async function readNotificationState(): Promise<StoredNotificationState> {
  const [[, dismissedValue], [, permissionValue]] = await AsyncStorage.multiGet([
    NOTIF_PROMPT_DISMISSED_KEY,
    NOTIF_OS_PERMISSION_KEY,
  ]);
  let osPermission: NotificationPermissionState =
    permissionValue === 'granted' || permissionValue === 'denied' ? permissionValue : null;

  // The OS is authoritative on every evaluation. This also handles members
  // upgrading from an older app version after already allowing or denying.
  if (Platform.OS !== 'web') {
    try {
      const current = await Notifications.getPermissionsAsync();
      const currentStatus: NotificationPermissionState = current.granted
        ? 'granted'
        : current.status === 'denied' && current.canAskAgain === false
          ? 'denied'
          : null;
      if (currentStatus !== osPermission) {
        osPermission = currentStatus;
        if (currentStatus) {
          await AsyncStorage.setItem(NOTIF_OS_PERMISSION_KEY, currentStatus);
        } else {
          await AsyncStorage.removeItem(NOTIF_OS_PERMISSION_KEY);
        }
      }
    } catch {
      // Keep the last confirmed status when the OS permission query is unavailable.
    }
  }

  return {
    dismissed: dismissedValue === 'true',
    osPermission,
  };
}

interface NotificationPermissionRequestResult {
  permission: Exclude<NotificationPermissionState, null>;
  needsSettings: boolean;
}

async function requestNotificationPermission(): Promise<NotificationPermissionRequestResult> {
  if (Platform.OS === 'web') return { permission: 'denied', needsSettings: false };

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Vivo Johari updates',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  const alreadyDenied =
    !existing.granted && existing.status === 'denied' && existing.canAskAgain === false;
  const result = existing.granted || alreadyDenied
    ? existing
    : await Notifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowBadge: true,
          allowSound: true,
        },
      });
  const permission: Exclude<NotificationPermissionState, null> =
    result.granted ? 'granted' : 'denied';
  await AsyncStorage.setItem(NOTIF_OS_PERMISSION_KEY, permission);
  return { permission, needsSettings: alreadyDenied };
}

interface NotificationPermissionPromptProps {
  mode: NotificationPromptMode;
  busy: boolean;
  onAllow: () => void;
  onDismiss: () => void;
  onOpenSettings: () => void;
}

function NotificationPermissionPrompt({
  mode,
  busy,
  onAllow,
  onDismiss,
  onOpenSettings,
}: NotificationPermissionPromptProps) {
  const isInitial = mode === 'initial';
  const isSettings = mode === 'settings';
  const heading = isInitial
    ? 'Stay in the loop'
    : isSettings
      ? 'Turn on notifications in Settings'
      : "Turn on notifications so you don't miss your bonus points";
  const body = isInitial
    ? 'Turn on notifications to get updates on rewards, exclusive drops, and community challenges — right when they happen.'
    : isSettings
      ? 'Notifications are currently turned off. Open your phone settings to enable updates from Vivo Johari.'
      : 'Get a timely heads-up when rewards, bonus points, and new Johari moments are ready for you.';

  const content = (
    <View style={isInitial ? styles.notificationGate : styles.notificationSheet}>
      <View style={styles.notificationIcon}>
        <Feather name="bell" size={25} color={colors.light.primaryDeep} />
      </View>
      <Text style={styles.notificationTitle}>{heading}</Text>
      <Text style={styles.notificationBody}>{body}</Text>
      <Pressable
        testID={isSettings ? 'notification-open-settings' : 'notification-allow'}
        onPress={isSettings ? onOpenSettings : onAllow}
        disabled={busy}
        style={({ pressed }) => [
          styles.notificationPrimaryButton,
          (pressed || busy) && styles.notificationButtonPressed,
        ]}
      >
        {busy ? (
          <ActivityIndicator color={colors.light.primaryForeground} />
        ) : (
          <Text style={styles.notificationPrimaryText}>
            {isSettings ? 'Open Settings' : 'Allow Notifications'}
          </Text>
        )}
      </Pressable>
      <Pressable
        testID="notification-not-now"
        onPress={onDismiss}
        disabled={busy}
        style={({ pressed }) => [
          styles.notificationSecondaryButton,
          pressed && styles.notificationButtonPressed,
        ]}
      >
        <Text style={styles.notificationSecondaryText}>Not now</Text>
      </Pressable>
    </View>
  );

  if (isInitial) {
    return <View style={styles.notificationFullScreen}>{content}</View>;
  }

  return (
    <View style={styles.notificationScrim}>
      <View style={styles.notificationSheetWrap}>{content}</View>
    </View>
  );
}

function encodeJavaScriptString(value: string) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function tokenBootstrap(token: string) {
  return `
    (function () {
      var token = ${encodeJavaScriptString(token)};
      if (token) {
        try { localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, token); } catch (_) {}
      }
    })();
    true;
  `;
}

function clearWebSession() {
  return `
    (function () {
      try {
        localStorage.removeItem(${JSON.stringify(TOKEN_KEY)});
        localStorage.removeItem("vivo_community_cart_v1");
        localStorage.removeItem("vivo_community_wishlist_v1");
        localStorage.removeItem("vivo_guest");
        sessionStorage.clear();
      } catch (_) {}
    })();
    true;
  `;
}

function isExternalScheme(url: string) {
  return /^(tel:|mailto:|sms:|whatsapp:|geo:|maps:|intent:)/i.test(url);
}

function isCommunityDocumentUrl(url: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.origin === COMMUNITY_ORIGIN &&
      (parsed.pathname === '/app' || parsed.pathname.startsWith('/app/'))
    );
  } catch {
    return false;
  }
}

function applyPathDeepLink(destination: URL, pathname: string) {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (!parts.length) return;
  const [kind, ...rest] = parts;
  const value = rest.join('/');
  if (kind === 'product' && value) {
    destination.searchParams.set('tab', 'shop');
    destination.searchParams.set('product', value);
  } else if (kind === 'event' && value) {
    destination.searchParams.set('tab', 'community');
    destination.searchParams.set('event', value);
  } else if (kind === 'article' && value) {
    destination.searchParams.set('page', `article-${value}`);
  } else if (kind === 'page' && value) {
    destination.searchParams.set('page', value);
  } else if (kind === 'community' && value) {
    destination.searchParams.set('tab', 'community');
    destination.searchParams.set('sub', value);
  } else if (kind === 'referral' && value) {
    destination.searchParams.set('ref', value);
  } else if (['home', 'shop', 'community', 'rewards', 'profile'].includes(kind)) {
    destination.searchParams.set('tab', kind);
  }
}

function deepLinkToWebUrl(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      if (isCommunityDocumentUrl(rawUrl)) return rawUrl;
      return COMMUNITY_URL;
    }
    const destination = new URL(COMMUNITY_URL);
    applyPathDeepLink(destination, parsed.pathname);
    parsed.searchParams.forEach((value, key) => destination.searchParams.set(key, value));
    if (parsed.hash) destination.hash = parsed.hash;
    return destination.toString();
  } catch {
    return COMMUNITY_URL;
  }
}

export default function CommunityWebView() {
  const webViewRef = useRef<WebView>(null);
  const [secureToken, setSecureToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [sourceUrl, setSourceUrl] = useState(COMMUNITY_URL);
  const [notificationPrompt, setNotificationPrompt] = useState<NotificationPromptMode | null>(null);
  const [notificationBusy, setNotificationBusy] = useState(false);

  const webViewSource = useMemo(() => ({ uri: sourceUrl }), [sourceUrl]);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      SecureStore.getItemAsync(TOKEN_KEY),
      Linking.getInitialURL(),
    ])
      .then(([token, initialUrl]) => {
        if (!mounted) return;
        setSecureToken(token);
        if (initialUrl) setSourceUrl(deepLinkToWebUrl(initialUrl));
      })
      .catch(() => {
        if (mounted) setSecureToken(null);
      })
      .finally(() => {
        if (mounted) {
          setReady(true);
          setLoading(true);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const subscription = Linking.addEventListener('url', ({ url }) => {
      setSourceUrl(deepLinkToWebUrl(url));
      setLoadError('');
      webViewRef.current?.stopLoading();
    });
    return () => subscription.remove();
  }, []);

  const goBack = useCallback(() => {
    if (canGoBack) {
      webViewRef.current?.goBack();
      return true;
    }
    return false;
  }, [canGoBack]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', goBack);
    return () => subscription.remove();
  }, [goBack]);

  const openExternal = useCallback(async (url: string) => {
    try {
      const supported = await RNLinking.canOpenURL(url);
      if (supported) await RNLinking.openURL(url);
      else Alert.alert('Unable to open link', 'This action is not available on this device.');
    } catch {
      Alert.alert('Unable to open link', 'Please try again from your device.');
    }
  }, []);

  const showInitialNotificationPrompt = useCallback(async () => {
    const state = await readNotificationState();
    if (!state.osPermission && !state.dismissed) {
      setNotificationPrompt('initial');
    }
  }, []);

  const showContextualNotificationPrompt = useCallback(async () => {
    const state = await readNotificationState();
    if (state.osPermission === 'granted') return;
    if (state.osPermission === 'denied') {
      setNotificationPrompt('settings');
      return;
    }
    if (state.dismissed) setNotificationPrompt('contextual');
  }, []);

  const dismissNotificationPrompt = useCallback(async () => {
    if (notificationPrompt !== 'settings') {
      await AsyncStorage.setItem(NOTIF_PROMPT_DISMISSED_KEY, 'true');
    }
    setNotificationPrompt(null);
  }, [notificationPrompt]);

  const allowNotifications = useCallback(async () => {
    setNotificationBusy(true);
    try {
      // Note: confirm with backend/CRM whether granted notification permissions tie into
      // segment-specific push campaigns (e.g., Gold segment pilot invites) or general
      // Vivo Johari notifications only.
      const result = await requestNotificationPermission();
      setNotificationPrompt(result.needsSettings ? 'settings' : null);
    } catch {
      Alert.alert(
        'Unable to open notification permission',
        'Please try again. You can continue using Vivo Johari without notifications.',
      );
    } finally {
      setNotificationBusy(false);
    }
  }, []);

  const openNotificationSettings = useCallback(async () => {
    setNotificationBusy(true);
    try {
      await RNLinking.openSettings();
      setNotificationPrompt(null);
    } catch {
      Alert.alert('Unable to open Settings', 'Open your phone Settings and choose Vivo Johari.');
    } finally {
      setNotificationBusy(false);
    }
  }, []);

  const handleMessage = useCallback(async (event: WebViewMessageEvent) => {
    let message: {
      type?: string;
      token?: string;
      title?: string;
      text?: string;
      url?: string;
      moment?: string;
    };
    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }

    // Only the top-level Community document can read or mutate native state.
    // event.nativeEvent.url is supplied by the native WebView, not by page JS.
    if (!isCommunityDocumentUrl(event.nativeEvent.url)) return;

    if (message.type === 'auth-token') {
      // community_app.py issues secrets.token_urlsafe(32) session tokens.
      // Reject any other shape rather than persisting arbitrary page data.
      if (message.token && /^[A-Za-z0-9_-]{43}$/.test(message.token)) {
        await SecureStore.setItemAsync(TOKEN_KEY, message.token);
        setSecureToken(message.token);
        await showInitialNotificationPrompt();
      }
      return;
    }
    if (message.type === 'signed-out') {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
      setSecureToken(null);
      webViewRef.current?.injectJavaScript(clearWebSession());
      return;
    }
    if (message.type === 'share' && (message.url || message.text)) {
      try {
        await Share.share({
          title: message.title || 'Vivo Johari',
          message: [message.text, message.url].filter(Boolean).join('\n'),
          url: Platform.OS === 'ios' ? message.url : undefined,
        });
      } catch {
        // A cancelled native share sheet is not an error.
      }
      return;
    }
    if (message.type === 'clipboard' && message.text) {
      await Clipboard.setStringAsync(message.text);
      Alert.alert('Copied', 'The link is ready to paste.');
      return;
    }
    if (message.type === 'notification-moment' && message.moment === 'points-awarded') {
      await showContextualNotificationPrompt();
    }
  }, [showContextualNotificationPrompt, showInitialNotificationPrompt]);

  const handleNavigation = useCallback((request: WebViewNavigation) => {
    const { url } = request;
    if (/^vivo-johari:/i.test(url)) {
      setSourceUrl(deepLinkToWebUrl(url));
      return false;
    }
    if (isExternalScheme(url)) {
      void openExternal(url);
      return false;
    }
    if (/^https?:/i.test(url) && !isCommunityDocumentUrl(url)) {
      void openExternal(url);
      return false;
    }
    return true;
  }, [openExternal]);

  const handleOpenWindow = useCallback((event: { nativeEvent: { targetUrl: string } }) => {
    const url = event.nativeEvent.targetUrl;
    if (url) void openExternal(url);
  }, [openExternal]);

  const retry = useCallback(() => {
    setLoadError('');
    setLoading(true);
    webViewRef.current?.reload();
  }, []);

  if (!ready) return null;

  // react-native-webview is a native module and intentionally has no browser
  // implementation. Replit's Expo preview uses an iframe solely so reviewers
  // can inspect the same mobile route; Android and iOS always use WebView.
  if (Platform.OS === 'web') {
    return (
      <View style={styles.container}>
        {React.createElement('iframe', {
          title: 'Vivo Johari preview',
          src: sourceUrl,
          allow: 'camera; microphone; geolocation; clipboard-write',
          style: { width: '100%', height: '100%', border: 0 },
        })}
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <StatusBar style={notificationPrompt ? 'dark' : 'light'} />
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <WebView
          ref={webViewRef}
          source={webViewSource}
          originWhitelist={['https://*', 'http://*', 'tel:*', 'mailto:*', 'whatsapp:*', 'geo:*']}
          injectedJavaScriptBeforeContentLoaded={`${tokenBootstrap(secureToken || '')}${INJECTED_BOOT}`}
          onMessage={handleMessage}
          onShouldStartLoadWithRequest={handleNavigation}
          onOpenWindow={handleOpenWindow}
          onNavigationStateChange={(state) => {
            setCanGoBack(state.canGoBack);
          }}
          onLoadStart={() => { setLoading(true); setLoadError(''); }}
          onLoadEnd={() => setLoading(false)}
          onError={(event) => {
            setLoading(false);
            setLoadError(event.nativeEvent.description || 'We could not load Vivo Johari.');
          }}
          onContentProcessDidTerminate={() => webViewRef.current?.reload()}
          startInLoadingState
          javaScriptEnabled
          domStorageEnabled
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          allowsInlineMediaPlayback
          mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
          geolocationEnabled
          setSupportMultipleWindows={false}
          allowsBackForwardNavigationGestures
          keyboardDisplayRequiresUserAction={false}
          automaticallyAdjustContentInsets={false}
          bounces={Platform.OS === 'ios'}
          style={styles.webView}
        />
        {loading && !loadError && (
          <View pointerEvents="none" style={styles.loadingOverlay}>
            <View style={styles.loadingCard}>
              <ActivityIndicator color={colors.light.primary} />
              <Text style={styles.loadingText}>Opening Johari</Text>
            </View>
          </View>
        )}
        {!!loadError && (
          <View style={styles.errorOverlay}>
            <Text style={styles.errorKicker}>VIVO JOHARI</Text>
            <Text style={styles.errorTitle}>We’re having trouble connecting.</Text>
            <Text style={styles.errorBody}>
              Check your connection and try again. Your member session is kept safely on this device.
            </Text>
            <Pressable testID="community-mobile-retry" onPress={retry} style={styles.retryButton}>
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
            <Pressable testID="community-mobile-open-web" onPress={() => void openExternal(COMMUNITY_URL)} style={styles.secondaryButton}>
              <Text style={styles.secondaryText}>Open in browser</Text>
            </Pressable>
          </View>
        )}
        {notificationPrompt && (
          <NotificationPermissionPrompt
            mode={notificationPrompt}
            busy={notificationBusy}
            onAllow={() => void allowNotifications()}
            onDismiss={() => void dismissNotificationPrompt()}
            onOpenSettings={() => void openNotificationSettings()}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.light.primary },
  container: { flex: 1, backgroundColor: colors.light.background },
  webView: { flex: 1, backgroundColor: colors.light.background },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.light.background,
  },
  loadingCard: { alignItems: 'center', gap: 12 },
  loadingText: {
    color: colors.light.primaryDeep,
    fontFamily: 'Inter_600SemiBold',
    fontSize: 13,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    backgroundColor: colors.light.background,
  },
  errorKicker: {
    color: colors.light.primaryDeep,
    fontFamily: 'Inter_700Bold',
    fontSize: 11,
    letterSpacing: 2.4,
    marginBottom: 16,
  },
  errorTitle: {
    color: colors.light.foreground,
    fontFamily: 'Inter_700Bold',
    fontSize: 25,
    lineHeight: 31,
    textAlign: 'center',
    marginBottom: 12,
  },
  errorBody: {
    color: colors.light.mutedForeground,
    fontFamily: 'Inter_400Regular',
    fontSize: 15,
    lineHeight: 23,
    textAlign: 'center',
    marginBottom: 28,
  },
  retryButton: {
    minWidth: 160,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    backgroundColor: colors.light.primary,
    paddingHorizontal: 24,
  },
  retryText: {
    color: colors.light.primaryForeground,
    fontFamily: 'Inter_600SemiBold',
    fontSize: 15,
  },
  secondaryButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    marginTop: 8,
  },
  secondaryText: {
    color: colors.light.primaryDeep,
    fontFamily: 'Inter_600SemiBold',
    fontSize: 14,
  },
  notificationFullScreen: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
    backgroundColor: colors.light.background,
  },
  notificationGate: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 30,
    paddingVertical: 36,
    backgroundColor: colors.light.background,
  },
  notificationScrim: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
    justifyContent: 'flex-end',
    backgroundColor: colors.light.scrim,
  },
  notificationSheetWrap: {
    padding: 12,
  },
  notificationSheet: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 30,
    paddingBottom: 18,
    borderRadius: 16,
    backgroundColor: colors.light.card,
  },
  notificationIcon: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 28,
    marginBottom: 22,
    backgroundColor: colors.light.secondary,
  },
  notificationTitle: {
    maxWidth: 330,
    color: colors.light.foreground,
    fontFamily: 'Inter_700Bold',
    fontSize: 26,
    lineHeight: 32,
    textAlign: 'center',
    marginBottom: 12,
  },
  notificationBody: {
    maxWidth: 340,
    color: colors.light.mutedForeground,
    fontFamily: 'Inter_400Regular',
    fontSize: 15,
    lineHeight: 23,
    textAlign: 'center',
    marginBottom: 30,
  },
  notificationPrimaryButton: {
    width: '100%',
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: colors.radius,
    paddingHorizontal: 20,
    backgroundColor: colors.light.primary,
  },
  notificationPrimaryText: {
    color: colors.light.primaryForeground,
    fontFamily: 'Inter_600SemiBold',
    fontSize: 15,
  },
  notificationSecondaryButton: {
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    marginTop: 4,
  },
  notificationSecondaryText: {
    color: colors.light.primaryDeep,
    fontFamily: 'Inter_600SemiBold',
    fontSize: 14,
  },
  notificationButtonPressed: {
    opacity: 0.72,
  },
});