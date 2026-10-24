package main

import (
	"context"
	"embed"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	// Create an instance of the app structure
	app := NewApp()

	// Arguments come from the CLI wrapper: a repository path and an optional --base.
	startupPath, startupBase := parseLaunchArgs(os.Args[1:])

	// Create application with options
	err := wails.Run(&options.App{
		Title:  "git-tree-compare",
		Width:  1024,
		Height: 768,
		// Start filling the screen. The title bar is hidden; the toolbar takes its place
		// and the traffic-light buttons float over it.
		WindowStartState: options.Maximised,
		Mac: &mac.Options{
			TitleBar: mac.TitleBarHiddenInset(),
		},
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 27, G: 38, B: 54, A: 1},
		// A second launch with a path hands it to this window and exits.
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId:               "com.tinwritescode.git-tree-compare",
			OnSecondInstanceLaunch: app.onSecondInstance,
		},
		OnStartup: func(ctx context.Context) {
			app.startup(ctx)
			if startupPath != "" {
				app.requestRepo(startupPath, startupBase)
			}
		},
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
