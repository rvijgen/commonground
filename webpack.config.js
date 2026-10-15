import path from 'node:path';
import { fileURLToPath } from 'node:url';
import HtmlWebpackPlugin from 'html-webpack-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
	mode: 'development',
	entry: {
		index: './examples/test-cube/index.js',
	},
	module: {
		rules: [
			{
				test: /\.css$/i,
				use: ['style-loader', 'css-loader'],
			},
			{
				test: /\.js$/,
				exclude: /node_modules/,
				use: {
					loader: 'babel-loader',
					options: {
						presets: ['@babel/preset-env'],
					},
				},
			},
		],
	},
	devServer: {
		static: {
			directory: path.join(__dirname, 'dist'),
		},
		host: '0.0.0.0',
		server: 'https',
		compress: true,
		port: 8443,
		allowedHosts: 'all',
		proxy: {
			'/api': {
				target: 'http://localhost:3001',
				secure: false,
				changeOrigin: true,
				logLevel: 'debug'
			},
		},
		setupMiddlewares: (middlewares, devServer) => {
			// Disable localStorage access in SSR context
			return middlewares;
		},
	},
	resolve: {
		alias: {
			// Lets the example import 'commonground' like an installed app
			// would; resolves to the in-repo client library.
			commonground: path.resolve(__dirname, 'src', 'CommonGround.js'),
		},
		fallback: {
			"fs": false,
			"path": false,
			"os": false
		}
	},
	output: {
		filename: '[name].bundle.js',
		path: path.resolve(__dirname, 'dist'),
		publicPath: 'auto',
		clean: true,
	},
	plugins: [
		new HtmlWebpackPlugin({
			template: './examples/test-cube/index.build.html',
			inject: 'body',
			scriptLoading: 'blocking',
			minify: false
		}),
	],
	devtool: 'source-map',
};
