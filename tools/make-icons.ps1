# 鳥とんボード用アプリアイコンを生成するスクリプト
# 使い方: powershell -NoProfile -ExecutionPolicy Bypass -File tools/make-icons.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root 'icons'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

foreach ($s in @(180, 192, 512)) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

  # 背景(ボードのダーク色)
  $bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(23, 19, 15))
  $g.FillRectangle($bg, 0, 0, $s, $s)

  # オレンジの丸
  $accent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(217, 88, 30))
  $pad = [int]($s * 0.06)
  $g.FillEllipse($accent, $pad, $pad, $s - 2 * $pad, $s - 2 * $pad)

  # 白文字「鳥」をど真ん中に
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $font = New-Object System.Drawing.Font('Yu Gothic UI', [float]($s * 0.42), [System.Drawing.FontStyle]::Bold)
  $rect = New-Object System.Drawing.RectangleF(0.0, [float]($s * 0.03), [float]$s, [float]$s)
  $g.DrawString([char]0x9CE5, $font, [System.Drawing.Brushes]::White, $rect, $fmt)

  $out = Join-Path $dir "icon-$s.png"
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  Write-Output "生成: $out"
}
