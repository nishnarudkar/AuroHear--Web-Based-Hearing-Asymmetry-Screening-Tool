# 1. Start from an official Python base image
FROM python:3.10-slim

# 2. Set a working directory inside the container
WORKDIR /app

# 3. Copy your requirements file in first and install dependencies
# This is efficient because Docker won't re-install every time you change your code
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 4. Copy the rest of your application code into the container
COPY . .

# 5. Tell Docker what port your app will run on
# Render's log showed it detected port 10000, so we'll tell gunicorn to use that.
ENV PORT 10000
EXPOSE 10000

# 6. Define the command to run your app
# This is the same command from your Procfile, but more explicit
CMD ["gunicorn", "app:app", "--bind", "0.0.0.0:10000"]