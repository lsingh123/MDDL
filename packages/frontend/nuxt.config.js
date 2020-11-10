import messages from './assets/js/messages.ts'

export default {
  ssr: false,
  target: 'static',
  head: {
    titleTemplate: '%s - Datalocker',
    meta: [
      {
        charset: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        hid: 'description',
        name: 'description',
        content: process.env.npm_package_description || '',
      },
    ],
    link: [
      {
        rel: 'icon',
        type: 'image/x-icon',
        href: '/favicon.ico',
      },
    ],
  },
  css: ['@/assets/scss/main.scss'],
  styleResources: {
    scss: ['@/assets/scss/colors.scss', '@/assets/scss/variables.scss'],
  },
  plugins: ['@/plugins/api-accessor.ts', '@/plugins/vee-validate.js'],
  components: true,
  buildModules: [
    '@nuxt/typescript-build',
    '@nuxtjs/vuetify',
    '@nuxtjs/dotenv',
    '@nuxtjs/google-fonts',
  ],
  modules: [
    '@nuxtjs/style-resources',
    '@nuxtjs/axios',
    '@nuxtjs/auth',
    '@nuxtjs/pwa',
    'nuxt-i18n',
  ],
  i18n: {
    locales: ['en', 'test'],
    defaultLocale: 'en',
    vueI18n: {
      fallbackLocale: 'en',
      messages,
    },
    strategy: 'no_prefix',
  },
  googleFonts: {
    families: {
      'Noto Sans': [300, 400, 500, 600, 700],
    },
  },
  vuetify: {
    treeShake: true,
    customVariables: ['@/assets/scss/vuetifyVariables.scss'],
    optionsPath: './vuetify.options.ts',
  },
  publicRuntimeConfig: {
    agencyEmailDomainsWhitelist: process.env.AGENCY_EMAIL_DOMAINS_WHITELIST,
  },
  build: {
    // TODO: disabled due to issues with hot reloading
    //   extractCSS: true,
    transpile: ['vee-validate/dist/rules'],
  },
  generate: {
    dir: 'dist/' + process.env.OUTPUT_DIR,
  },
  /*
   ** Enforce auth for all routes
   ** Can be disabled by adding property `auth: false` to your page component
   */
  router: {
    middleware: ['auth', 'default'],
    extendRoutes(routes, resolve) {
      if (process.env.NODE_ENV === 'development') {
        routes.push({
          name: 'debug',
          path: '/debug',
          component: resolve(__dirname, 'components/DebugMenu/DebugMenu.vue'),
        })
      }
    },
  },
  /*
   ** Auth Config
   ** See https://auth.nuxtjs.org/schemes/oauth2.html#usage
   */
  auth: {
    strategies: {
      oauth2: {
        _scheme: 'oauth2',
        audience: process.env.API_URL,
        codeChallengeMethod: 'S256',
        authorization_endpoint: process.env.AUTH_URL + '/login',
        userinfo_endpoint: process.env.AUTH_URL + '/oauth2/userInfo',
        scope: ['openid', 'profile', 'email'],
        client_id: process.env.AUTH_CLIENT_ID,
        token_type: 'Bearer',
        token_key: 'access_token',
        response_type: 'token',
      },
      local: false,
    },
    redirect: {
      callback: '/authorize',
    },
    plugins: ['@plugins/store-accessor.ts'],
  },
}
