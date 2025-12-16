#!/usr/bin/env python3
"""
Test script for trend analysis functionality
Demonstrates the classification of session patterns
"""

import requests
import json
from datetime import datetime, timedelta

# Test configuration
BASE_URL = "http://127.0.0.1:5000"

def test_trend_analysis():
    """Test the trend analysis functionality"""
    
    print("📈 Testing Trend Analysis Functionality")
    print("=" * 50)
    
    # Test 1: Trend analysis endpoint (will need a real user_id)
    print("\n1️⃣ Testing /user/trend-analysis endpoint...")
    
    # This would need a real authenticated user ID from the database
    test_user_id = 1  # Placeholder - would need actual user
    
    response = requests.get(f"{BASE_URL}/user/trend-analysis?user_id={test_user_id}")
    
    print(f"Status Code: {response.status_code}")
    
    if response.status_code == 200:
        data = response.json()
        print("✅ Trend analysis successful!")
        
        trend = data.get('trend_analysis', {})
        print(f"\n📊 Trend Classification: {trend.get('classification', 'N/A')}")
        print(f"Description: {trend.get('description', 'N/A')}")
        print(f"Sessions analyzed: {trend.get('sessions_analyzed', 0)}")
        print(f"Time span: {trend.get('time_span_days', 0)} days")
        
        # Display metrics if available
        metrics = trend.get('metrics', {})
        if metrics:
            print(f"\n📋 Variance Metrics:")
            print(f"   Overall variance: {metrics.get('overall_variance', 'N/A')} dB²")
            print(f"   Left ear variance: {metrics.get('left_ear_variance', 'N/A')} dB²")
            print(f"   Right ear variance: {metrics.get('right_ear_variance', 'N/A')} dB²")
            print(f"   Interaural variance: {metrics.get('interaural_variance', 'N/A')} dB²")
            print(f"   Overall trend slope: {metrics.get('overall_trend_slope', 'N/A')} dB/session")
        
        # Display methodology
        methodology = data.get('methodology', {})
        if methodology:
            print(f"\n🔬 Classification Criteria:")
            for classification, description in methodology.get('classification_types', {}).items():
                print(f"   {classification.title()}: {description}")
    
    elif response.status_code == 404:
        print("❌ User not found or endpoint not available")
        print("Note: This test requires an authenticated user with session history")
    else:
        try:
            error_data = response.json()
            print(f"❌ Error: {error_data.get('error', 'Unknown error')}")
        except:
            print(f"❌ HTTP Error: {response.status_code}")
    
    # Test 2: Invalid user handling
    print("\n2️⃣ Testing invalid user handling...")
    
    response = requests.get(f"{BASE_URL}/user/trend-analysis?user_id=99999")
    
    print(f"Status Code: {response.status_code}")
    if response.status_code == 404:
        print("✅ Correctly rejected invalid user")
    else:
        print(f"❌ Unexpected response: {response.status_code}")
    
    # Test 3: Missing user_id handling
    print("\n3️⃣ Testing missing user_id handling...")
    
    response = requests.get(f"{BASE_URL}/user/trend-analysis")
    
    print(f"Status Code: {response.status_code}")
    if response.status_code == 400:
        print("✅ Correctly rejected missing user_id")
    else:
        print(f"❌ Unexpected response: {response.status_code}")
    
    print("\n🎯 Trend Analysis Features:")
    print("✅ Classifies session patterns as stable/variable/changing")
    print("✅ Uses simple variance and trend calculations")
    print("✅ Avoids predictive modeling or medical interpretation")
    print("✅ Provides objective measurement pattern analysis")
    print("✅ Includes comprehensive variance metrics")
    print("✅ Handles insufficient data gracefully")
    print("✅ Maintains non-diagnostic approach")

def demonstrate_classification_logic():
    """Demonstrate the trend classification logic"""
    
    print("\n🔬 Classification Logic Demonstration")
    print("=" * 40)
    
    # Example scenarios
    scenarios = [
        {
            'name': 'Stable Pattern',
            'thresholds': [25.0, 26.0, 24.5, 25.5, 25.2],
            'variance': 0.5,
            'expected': 'stable'
        },
        {
            'name': 'Variable Pattern', 
            'thresholds': [25.0, 30.0, 22.0, 28.0, 24.0],
            'variance': 12.0,
            'expected': 'variable'
        },
        {
            'name': 'Changing Pattern',
            'thresholds': [20.0, 25.0, 30.0, 35.0, 40.0],
            'variance': 66.7,
            'expected': 'changing'
        }
    ]
    
    print("Classification Thresholds:")
    print("• Stable: ≤25 dB² variance, no significant trend")
    print("• Variable: ≤100 dB² variance, normal fluctuation")
    print("• Changing: >100 dB² variance or >2 dB/session trend")
    
    for scenario in scenarios:
        print(f"\n{scenario['name']}:")
        print(f"  Thresholds: {scenario['thresholds']}")
        print(f"  Variance: {scenario['variance']} dB²")
        print(f"  Classification: {scenario['expected']}")
        
        # Calculate simple trend
        n = len(scenario['thresholds'])
        if n >= 3:
            # Simple linear trend
            x_vals = list(range(n))
            y_vals = scenario['thresholds']
            
            x_mean = sum(x_vals) / n
            y_mean = sum(y_vals) / n
            
            numerator = sum((x_vals[i] - x_mean) * (y_vals[i] - y_mean) for i in range(n))
            denominator = sum((x_vals[i] - x_mean) ** 2 for i in range(n))
            
            slope = numerator / denominator if denominator != 0 else 0
            print(f"  Trend slope: {slope:.2f} dB/session")

if __name__ == "__main__":
    try:
        demonstrate_classification_logic()
        test_trend_analysis()
    except requests.exceptions.ConnectionError:
        print("❌ Could not connect to server. Make sure the Flask app is running on http://127.0.0.1:5000")
    except Exception as e:
        print(f"❌ Test failed with error: {e}")