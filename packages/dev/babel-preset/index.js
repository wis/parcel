module.exports = () => ({
  presets: [
    [
      require('@babel/preset-env'),
      {
        targets: 'Chrome 75',
        modules: false,
      },
    ],
    require('@babel/preset-flow'),
  ],
  plugins: [
    require('@babel/plugin-proposal-class-properties'),
    require('@babel/plugin-proposal-nullish-coalescing-operator'),
    require('@babel/plugin-proposal-optional-chaining'),
    [
      require('@babel/plugin-transform-react-jsx'),
      {
        pragma: 'h',
      },
    ],
  ],
  env: {
    production: {
      plugins: [
        // Inline the value of PARCEL_BUILD_ENV during production builds so that
        // it can be removed through dead code elimination below
        [
          'babel-plugin-transform-inline-environment-variables',
          {include: ['PARCEL_BUILD_ENV']},
        ],
        'babel-plugin-minify-dead-code-elimination',
      ],
    },
  },
});
