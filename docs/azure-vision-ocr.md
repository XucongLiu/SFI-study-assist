# Azure AI Vision OCR Setup

This project uses Azure AI Vision Image Analysis OCR for page photos. The OCR script sends local page images to Azure and saves extracted Swedish text as JSON and TXT files.

## 1. Create the Azure resource

1. Open the Azure Portal.
2. Select **Create a resource**.
3. Search for **Computer Vision** or **Azure AI services**.
4. Create a **Computer Vision** resource if available. If Azure only shows a multi-service **Azure AI services** resource, that also works as long as it provides a Vision endpoint and key.
5. Choose the same subscription/resource group style you used for Speech.
6. Use a region allowed by your subscription policy. For your Speech resource, **Sweden Central** worked, so try that first.
7. Choose the free tier if Azure offers it.

## 2. Copy endpoint and key

In the resource page:

1. Open **Keys and Endpoint**.
2. Copy **KEY 1**.
3. Copy the **Endpoint**, for example:

```text
https://your-resource-name.cognitiveservices.azure.com/
```

Do not paste the key into the webpage or GitHub.

## 3. Add local credentials

In `deploy-site`, copy `.env.example` to `.env.local` and fill in:

```text
AZURE_VISION_ENDPOINT=https://your-resource-name.cognitiveservices.azure.com/
AZURE_VISION_KEY=your-key-here
```

`.env.local` is ignored by Git, so it stays only on your computer.

## 4. Run OCR

From `C:\Users\XLIHB8\OneDrive - KTH\SFI\deploy-site`:

```powershell
& "C:\Users\XLIHB8\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" scripts\azure-vision-ocr.js --input assets\sfi-week2-pages --output data\ocr\week-02
```

The script creates:

```text
data/ocr/week-02/page-01.json
data/ocr/week-02/page-01.txt
...
```

Use `--force` if you want to overwrite existing OCR output:

```powershell
& "C:\Users\XLIHB8\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" scripts\azure-vision-ocr.js --input assets\sfi-week2-pages --output data\ocr\week-02 --force
```

## 5. How we use the OCR result

The OCR result should be treated as a first draft:

1. Azure extracts Swedish lines and word boxes from each page image.
2. We review the extracted `.txt` beside the page photo.
3. We correct any OCR mistakes.
4. Only then do we translate the verified Swedish text to English and update the site.

This is more reliable than manually reading every photo, but it still needs review because worksheet blanks, QR codes, columns, and faint text can confuse OCR.
