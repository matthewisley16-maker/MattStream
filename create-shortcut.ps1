# Creates the MattStream icon (if needed), a desktop shortcut and a Start Menu entry.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $root 'start.bat'
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$iconPath = Join-Path $root 'icon.ico'

if (-not (Test-Path $launcher)) { throw "start.bat is missing next to this script." }

if (-not (Test-Path $iconPath)) {
    Add-Type -AssemblyName System.Drawing
    $size = 256
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # rounded square with a diagonal gradient
    $glyph = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = 56
    $glyph.AddArc(8, 8, $d, $d, 180, 90)
    $glyph.AddArc($size - 8 - $d, 8, $d, $d, 270, 90)
    $glyph.AddArc($size - 8 - $d, $size - 8 - $d, $d, $d, 0, 90)
    $glyph.AddArc(8, $size - 8 - $d, $d, $d, 90, 90)
    $glyph.CloseFigure()

    $start = New-Object System.Drawing.Point(8, 8)
    $finish = New-Object System.Drawing.Point(248, 248)
    $pink = [System.Drawing.Color]::FromArgb(255, 255, 61, 113)
    $amber = [System.Drawing.Color]::FromArgb(255, 255, 159, 28)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($start, $finish, $pink, $amber)
    $g.FillPath($brush, $glyph)

    # white play triangle
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $triangle = @(
        (New-Object System.Drawing.PointF(102, 76)),
        (New-Object System.Drawing.PointF(102, 180)),
        (New-Object System.Drawing.PointF(188, 128))
    )
    $g.FillPolygon($white, $triangle)
    $g.Dispose()

    # PNG-based .ico (supported by Windows Vista and newer)
    $stream = New-Object System.IO.MemoryStream
    $bmp.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $png = $stream.ToArray()
    $stream.Dispose()
    $bmp.Dispose()

    $file = [System.IO.File]::Create($iconPath)
    $writer = New-Object System.IO.BinaryWriter($file)
    $writer.Write([UInt16]0)          # reserved
    $writer.Write([UInt16]1)          # type: icon
    $writer.Write([UInt16]1)          # one image
    $writer.Write([Byte]0)            # width 256
    $writer.Write([Byte]0)            # height 256
    $writer.Write([Byte]0)            # palette
    $writer.Write([Byte]0)            # reserved
    $writer.Write([UInt16]1)          # colour planes
    $writer.Write([UInt16]32)         # bits per pixel
    $writer.Write([UInt32]$png.Length)
    $writer.Write([UInt32]22)         # offset of the image data
    $writer.Write($png)
    $writer.Close()
    $file.Close()
}

function New-MattStreamShortcut([string]$linkPath) {
    $folder = Split-Path -Parent $linkPath
    if (-not (Test-Path $folder)) { New-Item -ItemType Directory -Path $folder | Out-Null }

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($linkPath)

    if (Test-Path $electron) {
        # The real app: Electron window, no console, taskbar entry and icon.
        $shortcut.TargetPath = $electron
        $shortcut.Arguments = '.'
    } else {
        # Without Electron, fall back to the launcher script.
        $shortcut.TargetPath = $launcher
    }

    $shortcut.WorkingDirectory = $root
    $shortcut.IconLocation = "$iconPath,0"
    $shortcut.Description = 'MattStream - your own movie platform'
    $shortcut.WindowStyle = 1
    $shortcut.Save()
    return $shortcut.TargetPath
}

$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'MattStream.lnk'
$startMenuDir = Join-Path ([Environment]::GetFolderPath('Programs')) 'MattStream'
$startMenuLink = Join-Path $startMenuDir 'MattStream.lnk'

$target = New-MattStreamShortcut $desktopLink
New-MattStreamShortcut $startMenuLink | Out-Null

Write-Host "Desktop shortcut: $desktopLink"
Write-Host "Start Menu:       $startMenuLink"
Write-Host "Launches:         $target"
Write-Host "Icon:             $iconPath"
