module.exports = (isProduction) => ({
    entry: "./src/client/js/app.js",
    mode: isProduction ? 'production' : 'development',
    output: {
        path: process.env.VERCEL ? __dirname + '/dist' : __dirname,
        filename: "app.js"
    },
    devtool: false,
    module: {
        rules: getRules(isProduction)
    },
    resolve: {
        fallback: {
            "buffer": false,
            "crypto": false,
            "util": false,
            "stream": false
        }
    },
    target: 'web'
});

function getRules(isProduction) {
    if (isProduction) {
        return [
            {
                test: /\.(?:js|mjs|cjs)$/,
                exclude: /node_modules/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        presets: [
                            ['@babel/preset-env', {
                                targets: "defaults"
                            }]
                        ]
                    }
                }
            }
        ]
    }
    return [];
}
